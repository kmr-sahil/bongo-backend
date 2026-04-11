const express = require("express");
const { authenticateToken } = require("../helpers/middleware");
const { getRole } = require("../helpers/getrole");
const pool = require("../db");
const { v4: uuidv4 } = require("uuid");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { upload, s3Client } = require("../helpers/uploadImage");
const sendMail = require("../helpers/sendMail");

const router = express.Router();

const normalizeStockStatus = (stock, stockStatus) => {
  if (Number(stock) > 0) return "in-stock";
  return stockStatus === "upcoming" ? "upcoming" : "out-of-stock";
};

// Middleware to check admin role
const requireAdmin = async (req, res, next) => {
  const role = await getRole(req.user.id);
  if (role !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
};

// ============================================================
// Products
// ============================================================

router.get("/search", async (req, res) => {
  const { query, limit = 20 } = req.query;

  if (!query) {
    return res.status(400).json({ message: "Search query is required" });
  }

  try {
    const result = await pool.query(
      `
      SELECT 
        p.id,
        p.name,
        p.slug,
        p.description,
        p.price,
        p.sale_price,
        p.stock,
        p.is_bestseller,
        p.created_at,
        c.name AS category_name,
        c.slug AS category_slug,
        array_agg(pi.image_url ORDER BY pi.sort_order) AS images
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN product_images pi ON pi.product_id = p.id
      WHERE 
        p.is_visible = TRUE
        AND (
          p.name ILIKE $1
          OR p.description ILIKE $1
          OR $2 = ANY(p.keywords)
          OR c.name ILIKE $1
        )
      GROUP BY p.id, c.name, c.slug
      ORDER BY p.is_bestseller DESC, p.created_at DESC
      LIMIT $3
      `,
      [`%${query}%`, query, limit],
    );

    res.json({ products: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/products", async (req, res) => {
  const {
    category,
    q,
    sort = "newest",
    page = 1,
    per_page = 20,
    min_price,
    max_price,
  } = req.query;

  const currentPage = parseInt(page);
  const perPage = parseInt(per_page);
  const offset = (currentPage - 1) * perPage;

  try {
    const params = [];
    let paramIndex = 1;

    let whereConditions = `WHERE p.is_visible = true`;

    let categories = [];

    if (category) {
      categories = category.split(","); // ["books-magazines", "childrens-books-early-learning", ...]
      console.log("Filtering by categories:", categories);
    }

    if (categories.length > 0) {
      const placeholders = categories.map(() => `$${paramIndex++}`).join(", ");
      whereConditions += ` AND c.slug IN (${placeholders})`;
      params.push(...categories);
    }

    if (q) {
      whereConditions += ` AND (
        p.name ILIKE $${paramIndex}
        OR p.description ILIKE $${paramIndex}
        OR $${paramIndex} = ANY(p.keywords)
      )`;
      params.push(`%${q}%`);
      paramIndex++;
    }

    // 💰 Price filtering
    if (min_price && max_price) {
      whereConditions += ` AND p.sale_price BETWEEN $${paramIndex} AND $${paramIndex + 1}`;
      params.push(min_price, max_price);
      paramIndex += 2;
    } else if (min_price) {
      whereConditions += ` AND p.sale_price >= $${paramIndex}`;
      params.push(min_price);
      paramIndex++;
    } else if (max_price) {
      whereConditions += ` AND p.sale_price <= $${paramIndex}`;
      params.push(max_price);
      paramIndex++;
    }

    // 🧠 ORDER BY logic
    let orderByClause = "p.created_at DESC"; // default

    switch (sort) {
      case "newest":
        orderByClause = "p.created_at DESC";
        break;

      case "price-low":
        orderByClause = "p.price ASC";
        break;

      case "price-high":
        orderByClause = "p.price DESC";
        break;

      case "bestseller":
        orderByClause = "p.is_bestseller DESC, p.created_at DESC";
        break;

      case "most-wishlisted":
        orderByClause = "wishlist_count DESC NULLS LAST";
        break;

      default:
        orderByClause = "p.created_at DESC";
    }

    // total count
    const countQuery = `
      SELECT COUNT(*) 
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ${whereConditions}
    `;

    const totalResult = await pool.query(countQuery, params);
    const totalItems = parseInt(totalResult.rows[0].count);
    const totalPages = Math.ceil(totalItems / perPage);

    // 🚀 MAIN QUERY (with wishlist support)
    const productQuery = `
      SELECT 
        p.id, p.name, p.slug, p.description, p.price, p.sale_price, p.sku, p.stock,
        CASE
          WHEN COALESCE(p.stock, 0) > 0 THEN 'in-stock'
          WHEN p.stock_status = 'upcoming' THEN 'upcoming'
          ELSE 'out-of-stock'
        END AS stock_status,
        p.weight, p.size_or_dimensions, p.keywords, p.is_bestseller, p.is_visible,
        p.created_at, p.updated_at,
        c.name as category_name, c.slug as category_slug,

        COALESCE(w.wishlist_count, 0) as wishlist_count,

        array_agg(pi.image_url ORDER BY pi.sort_order) as images

      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN product_images pi ON p.id = pi.product_id

      LEFT JOIN (
        SELECT product_id, COUNT(*) as wishlist_count
        FROM wishlists
        GROUP BY product_id
      ) w ON p.id = w.product_id

      ${whereConditions}

      GROUP BY p.id, c.name, c.slug, w.wishlist_count

      ORDER BY ${orderByClause}

      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const productParams = [...params, perPage, offset];

    const products = await pool.query(productQuery, productParams);

    res.json({
      data: products.rows,
      total_items: totalItems,
      total_pages: totalPages,
      current_page: currentPage,
      per_page: perPage,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /products/:id - Get product details with images
router.get("/products/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const product = await pool.query(
      `
      SELECT p.id, p.name, p.slug, p.description, p.price, p.sale_price, p.sku, p.stock,
             CASE
               WHEN COALESCE(p.stock, 0) > 0 THEN 'in-stock'
               WHEN p.stock_status = 'upcoming' THEN 'upcoming'
               ELSE 'out-of-stock'
             END AS stock_status,
             p.weight, p.size_or_dimensions, p.keywords, p.is_bestseller, p.is_visible,
             p.created_at, p.updated_at,
             c.name as category_name, c.slug as category_slug
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.slug = $1 AND p.is_visible = true
    `,
      [id],
    );

    if (product.rows.length === 0) {
      return res.status(404).json({ message: "Product not found" });
    }

    const productData = product.rows[0];

    const images = await pool.query(
      "SELECT id, image_url AS url, alt_text, sort_order FROM product_images WHERE product_id = $1 ORDER BY sort_order",
      [productData.id],
    );

    const result = { ...product.rows[0], images: images.rows };
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /products - Create product (admin only)
router.post("/products", authenticateToken, requireAdmin, async (req, res) => {
  const {
    name,
    slug,
    description,
    category_id,
    price,
    sale_price,
    sku,
    stock,
    weight,
    size_or_dimensions,
    keywords,
    is_bestseller,
    is_visible,
    stock_status,
  } = req.body;

  if (!name || !slug || !description || !category_id || !price) {
    return res.status(400).json({
      message: "Name, slug, description, category_id, and price are required",
    });
  }

  try {
    const normalizedStock = Number(stock) || 0;
    const normalizedStockStatus = normalizeStockStatus(
      normalizedStock,
      stock_status,
    );

    const newProduct = await pool.query(
      `
      INSERT INTO products (name, slug, description, category_id, price, sale_price, sku, stock,
                           weight, size_or_dimensions, keywords, is_bestseller, is_visible, stock_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id, name, slug, description, category_id, price, sale_price, sku, stock,
                weight, size_or_dimensions, keywords, is_bestseller, is_visible, stock_status, created_at, updated_at
    `,
      [
        name,
        slug,
        description,
        category_id,
        price,
        sale_price || null,
        sku || null,
        normalizedStock,
        weight || null,
        size_or_dimensions || null,
        keywords || [],
        is_bestseller || false,
        is_visible !== false,
        normalizedStockStatus,
      ],
    );

    res.status(201).json(newProduct.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      res.status(400).json({ message: "Product slug or SKU already exists" });
    } else if (error.code === "23503") {
      res.status(400).json({ message: "Invalid category_id" });
    } else {
      console.error(error);
      res.status(500).json({ message: "Server error" });
    }
  }
});

// PUT /products/:id - Update product (admin only)
router.put(
  "/products/:id",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const { id } = req.params;
    const {
      name,
      slug,
      description,
      category_id,
      price,
      sale_price,
      sku,
      stock,
      weight,
      size_or_dimensions,
      keywords,
      is_bestseller,
      is_visible,
      stock_status,
    } = req.body;

    if (!name || !slug || !description || !category_id || !price) {
      return res.status(400).json({
        message: "Name, slug, description, category_id, and price are required",
      });
    }

    try {
      // 🧠 STEP 1: Get old stock
      const existingProduct = await pool.query(
        "SELECT stock FROM products WHERE id = $1",
        [id],
      );

      if (existingProduct.rows.length === 0) {
        return res.status(404).json({ message: "Product not found" });
      }

      const oldStock = existingProduct.rows[0].stock;
      const newStock = Number(stock) || 0;
      const normalizedStockStatus = normalizeStockStatus(newStock, stock_status);

      // 🧾 STEP 2: Update product
      const updatedProduct = await pool.query(
        `
        UPDATE products SET name = $1, slug = $2, description = $3, category_id = $4, price = $5,
                            sale_price = $6, sku = $7, stock = $8, weight = $9, size_or_dimensions = $10,
                            keywords = $11, is_bestseller = $12, is_visible = $13, stock_status = $14
        WHERE id = $15
        RETURNING id, name, slug, description, category_id, price, sale_price, sku, stock,
                  weight, size_or_dimensions, keywords, is_bestseller, is_visible, stock_status, created_at, updated_at
      `,
        [
          name,
          slug,
          description,
          category_id,
          price,
          sale_price || null,
          sku || null,
          newStock,
          weight || null,
          size_or_dimensions || null,
          keywords || [],
          is_bestseller || false,
          is_visible !== false,
          normalizedStockStatus,
          id,
        ],
      );

      const product = updatedProduct.rows[0];

      // 🔔 STEP 3: Trigger notify ONLY if stock came back
      if (oldStock === 0 && newStock > 0) {
        // fetch users waiting
        const notifyUsers = await pool.query(
          `
          SELECT pn.user_id, u.email, p.name
          FROM product_notifications pn
          JOIN users u ON u.id = pn.user_id
          JOIN products p ON p.id = pn.product_id
          WHERE pn.product_id = $1
          AND pn.notified = FALSE
        `,
          [id],
        );

        const users = notifyUsers.rows;

        // ⚡ fire-and-forget async email sending
        (async () => {
          try {
            for (const user of users) {
              await sendMail({
                to: user.email,
                subject: `🔥 ${user.name} is back in stock!`,
                text: `Good news! The product "${user.name}" is available again. Grab it before it's gone!`,
              });
            }

            // mark as notified
            await pool.query(
              `
              UPDATE product_notifications
              SET notified = TRUE
              WHERE product_id = $1
            `,
              [id],
            );
          } catch (err) {
            console.error("Notify email error:", err);
          }
        })();
      }

      res.json(product);
    } catch (error) {
      if (error.code === "23505") {
        res.status(400).json({ message: "Product slug or SKU already exists" });
      } else if (error.code === "23503") {
        res.status(400).json({ message: "Invalid category_id" });
      } else {
        console.error(error);
        res.status(500).json({ message: "Server error" });
      }
    }
  },
);

// DELETE /products/:id - Delete product (admin only)
router.delete(
  "/products/:id",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const { id } = req.params;

    try {
      const productExists = await pool.query(
        "SELECT id FROM products WHERE id = $1",
        [id],
      );

      if (productExists.rows.length === 0) {
        return res.status(404).json({ message: "Product not found" });
      }

      const orderReference = await pool.query(
        "SELECT 1 FROM order_items WHERE product_id = $1 LIMIT 1",
        [id],
      );

      if (orderReference.rows.length > 0) {
        await pool.query(
          `UPDATE products
           SET is_visible = FALSE,
               stock = 0,
               stock_status = 'out-of-stock',
               updated_at = NOW()
           WHERE id = $1`,
          [id],
        );

        return res.json({
          message:
            "Product has order history, so it was archived instead of deleted",
          archived: true,
        });
      }

      await pool.query("DELETE FROM products WHERE id = $1", [id]);

      return res.json({ message: "Product deleted successfully", archived: false });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Server error" });
    }
  },
);

// ============================================================
// Product Images
// ============================================================

// GET /products/images/:id - Get images for a product
router.get("/images/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const images = await pool.query(
      "SELECT id, image_url, alt_text, sort_order FROM product_images WHERE product_id = $1 ORDER BY sort_order",
      [id],
    );
    res.json(images.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /products/id/:id - Get product details with images
router.get("/id/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const product = await pool.query(
      `
      SELECT 
        p.id,
        p.name,
        p.slug,
        p.description,
        p.price,
        p.sale_price,
        p.sku,
        p.stock,
        CASE
          WHEN COALESCE(p.stock, 0) > 0 THEN 'in-stock'
          WHEN p.stock_status = 'upcoming' THEN 'upcoming'
          ELSE 'out-of-stock'
        END AS stock_status,
        p.weight,
        p.size_or_dimensions,
        p.keywords,
        p.is_bestseller,
        p.is_visible,
        p.created_at,
        p.updated_at,
        p.category_id
      FROM products p
      WHERE p.id = $1
    `,
      [id],
    );

    if (product.rows.length === 0) {
      return res.status(404).json({ message: "Product not found" });
    }

    const productData = product.rows[0];

    const images = await pool.query(
      `
      SELECT 
        id,
        image_url AS url,
        alt_text,
        sort_order
      FROM product_images
      WHERE product_id = $1
      ORDER BY sort_order
    `,
      [productData.id],
    );

    res.json({
      ...productData,
      images: images.rows,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /products/:id/images - Add image to product (admin only)
router.post(
  "/images/:id",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const { id } = req.params;
    const { image_url, alt_text, sort_order } = req.body;

    if (!image_url) {
      return res.status(400).json({ message: "Image URL is required" });
    }

    try {
      // Check if product exists
      const product = await pool.query(
        "SELECT id FROM products WHERE id = $1",
        [id],
      );
      if (product.rows.length === 0) {
        return res.status(404).json({ message: "Product not found" });
      }

      const newImage = await pool.query(
        "INSERT INTO product_images (product_id, image_url, alt_text, sort_order) VALUES ($1, $2, $3, $4) RETURNING id, image_url, alt_text, sort_order",
        [id, image_url, alt_text || null, sort_order || 0],
      );

      res.status(201).json(newImage.rows[0]);
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Server error" });
    }
  },
);

// PUT /products/:id/images/:imageId - Update image (admin only)
router.put(
  "/images/:id/:imageId",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const { id, imageId } = req.params;
    const { image_url, alt_text, sort_order } = req.body;

    if (!image_url) {
      return res.status(400).json({ message: "Image URL is required" });
    }

    try {
      const updatedImage = await pool.query(
        "UPDATE product_images SET image_url = $1, alt_text = $2, sort_order = $3 WHERE id = $4 AND product_id = $5 RETURNING id, image_url, alt_text, sort_order",
        [image_url, alt_text || null, sort_order || 0, imageId, id],
      );

      if (updatedImage.rows.length === 0) {
        return res.status(404).json({ message: "Image not found" });
      }

      res.json(updatedImage.rows[0]);
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Server error" });
    }
  },
);

// DELETE /products/:id/images/:imageId - Delete image (admin only)
router.delete(
  "/images/:id/:imageId",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const { id, imageId } = req.params;

    try {
      const result = await pool.query(
        "DELETE FROM product_images WHERE id = $1 AND product_id = $2 RETURNING id",
        [imageId, id],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ message: "Image not found" });
      }

      res.json({ message: "Image deleted successfully" });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Server error" });
    }
  },
);

// ============================================================
// Product Views
// ============================================================

// POST /products/:id/view - Record a product view (authenticated users)
router.post("/view/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    // Check if product exists
    const product = await pool.query("SELECT id FROM products WHERE id = $1", [
      id,
    ]);
    if (product.rows.length === 0) {
      return res.status(404).json({ message: "Product not found" });
    }

    await pool.query(
      "INSERT INTO product_views (product_id, user_id) VALUES ($1, $2)",
      [id, req.user.id],
    );

    res.json({ message: "View recorded" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post(
  "/upload-image",
  authenticateToken,
  requireAdmin,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No image file provided" });
      }

      const file = req.file;
      const fileName = `products/${uuidv4()}`;

      // Upload to R2
      const uploadParams = {
        Bucket: process.env.R2_BUCKET_NAME,
        Key: fileName,
        Body: file.buffer,
        ContentType: file.mimetype,
        ACL: "public-read",
      };

      const command = new PutObjectCommand(uploadParams);
      await s3Client.send(command);

      // Generate the public URL
      const imageUrl = `${process.env.R2_PUBLIC_URL}/${process.env.R2_BUCKET_NAME}/${fileName}`;

      res.json({ url: imageUrl });
    } catch (error) {
      console.error("Image upload error:", error);
      res.status(500).json({ message: "Failed to upload image" });
    }
  },
);

router.post("/notify-me", authenticateToken, async (req, res) => {
  const userId = req.user.id; // from JWT
  const { product_id } = req.body;

  if (!product_id) {
    return res.status(400).json({ message: "Product ID is required" });
  }

  try {
    // 🧠 Step 1: Check product exists
    const productCheck = await pool.query(
      "SELECT id, stock FROM products WHERE id = $1",
      [product_id],
    );

    if (productCheck.rows.length === 0) {
      return res.status(404).json({ message: "Product not found" });
    }

    const product = productCheck.rows[0];

    // ⚠️ Optional UX: if already in stock, no need to notify
    if (product.stock > 0) {
      return res.status(400).json({
        message: "Product is already in stock, no need to subscribe",
      });
    }

    // 🧾 Step 2: Insert notify request (avoid duplicates)
    await pool.query(
      `
        INSERT INTO product_notifications (user_id, product_id)
        VALUES ($1, $2)
        ON CONFLICT (user_id, product_id) DO NOTHING
        `,
      [userId, product_id],
    );

    return res.json({
      message: "You will be notified when the product is back in stock 🔔",
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
