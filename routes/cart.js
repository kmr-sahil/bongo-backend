const express = require("express");
const { authenticateToken } = require("../helpers/middleware");
const pool = require("../db");

const router = express.Router();

const VALID_PAYMENT_METHODS = new Set(["cod", "upi", "card", "netbanking", "wallet"]);

const parsePositiveInteger = (value) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
};

// ============================================================
// Wishlist Routes
// ============================================================

// GET /wishlist - Get user's wishlist
router.get("/wishlist", authenticateToken, async (req, res) => {
  try {
    const wishlist = await pool.query(
      `
      SELECT 
        w.id,
        w.product_id,
        w.created_at,

        json_build_object(
          'id', p.id,
          'name', p.name,
          'slug', p.slug,
          'price', p.price,
          'sale_price', p.sale_price,
          'category', c.name,
          'stock_status', CASE WHEN p.stock > 0 THEN 'in-stock' ELSE 'out-of-stock' END,
          'images', COALESCE(
            json_agg(
              json_build_object(
                'url', pi.image_url
              )
              ORDER BY pi.sort_order
            ) FILTER (WHERE pi.id IS NOT NULL),
            '[]'
          )
        ) as product

      FROM wishlists w
      JOIN products p ON w.product_id = p.id
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN product_images pi ON p.id = pi.product_id

      WHERE w.user_id = $1

      GROUP BY w.id, p.id, c.name
      ORDER BY w.created_at DESC
      `,
      [req.user.id],
    );

    res.json(wishlist.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /wishlist - Add product to wishlist
router.post("/wishlist", authenticateToken, async (req, res) => {
  const { product_id } = req.body;

  if (!product_id) {
    return res.status(400).json({ message: "Product ID is required" });
  }

  try {
    // Check if product exists
    const product = await pool.query("SELECT id FROM products WHERE id = $1", [
      product_id,
    ]);
    if (product.rows.length === 0) {
      return res.status(404).json({ message: "Product not found" });
    }

    // Check if already in wishlist
    const existing = await pool.query(
      "SELECT id FROM wishlists WHERE user_id = $1 AND product_id = $2",
      [req.user.id, product_id],
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ message: "Product already in wishlist" });
    }

    const newWishlistItem = await pool.query(
      "INSERT INTO wishlists (user_id, product_id) VALUES ($1, $2) RETURNING id, created_at",
      [req.user.id, product_id],
    );

    res.status(201).json(newWishlistItem.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /wishlist/:productId - Remove product from wishlist
router.delete("/wishlist/:productId", authenticateToken, async (req, res) => {
  const { productId } = req.params;

  if (!productId || productId === "undefined") {
    return res.status(400).json({ message: "Product ID is required" });
  }

  if (!/^[0-9a-fA-F-]{36}$/.test(productId)) {
    return res.status(400).json({ message: "Invalid Product ID" });
  }

  try {
    const result = await pool.query(
      "DELETE FROM wishlists WHERE user_id = $1 AND product_id = $2 RETURNING id",
      [req.user.id, productId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Product not in wishlist" });
    }

    res.json({ message: "Product removed from wishlist" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// ============================================================
// Cart Routes
// ============================================================

// GET /cart - Get user's cart
router.get("/cart", authenticateToken, async (req, res) => {
  try {
    const cart = await pool.query(
      `
      SELECT ct.id, ct.quantity, ct.created_at,
             p.id as product_id, p.name, p.slug, p.price, p.sale_price, p.stock,
             cat.name as category_name, cat.slug as category_slug,
             COALESCE(
               array_agg(pi.image_url ORDER BY pi.sort_order) FILTER (WHERE pi.id IS NOT NULL),
               '{}'
             ) as images
      FROM cart ct
      JOIN products p ON ct.product_id = p.id
      LEFT JOIN categories cat ON p.category_id = cat.id
      LEFT JOIN product_images pi ON p.id = pi.product_id
      WHERE ct.user_id = $1
      GROUP BY ct.id, p.id, cat.name, cat.slug
      ORDER BY ct.created_at DESC
      `,
      [req.user.id],
    );
    res.json(cart.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /cart - Add product to cart
router.post("/cart", authenticateToken, async (req, res) => {
  const { product_id } = req.body;
  const quantity = parsePositiveInteger(req.body.quantity ?? 1);

  if (!product_id) {
    return res.status(400).json({ message: "Product ID is required" });
  }
  if (!quantity) {
    return res.status(400).json({ message: "Valid quantity is required" });
  }

  try {
    // Check if product exists and has stock
    const product = await pool.query(
      "SELECT id, price, sale_price, stock FROM products WHERE id = $1",
      [product_id],
    );
    if (product.rows.length === 0) {
      return res.status(404).json({ message: "Product not found" });
    }
    const productRow = product.rows[0];

    if (productRow.stock < quantity) {
      return res.status(400).json({ message: "Insufficient stock" });
    }

    // Check if already in cart
    const existing = await pool.query(
      "SELECT id, quantity FROM cart WHERE user_id = $1 AND product_id = $2",
      [req.user.id, product_id],
    );
    if (existing.rows.length > 0) {
      // Update quantity
      const newQuantity = existing.rows[0].quantity + quantity;
      if (productRow.stock < newQuantity) {
        return res.status(400).json({ message: "Insufficient stock" });
      }

      const updated = await pool.query(
        "UPDATE cart SET quantity = $1, updated_at = NOW() WHERE id = $2 RETURNING id, quantity, updated_at",
        [newQuantity, existing.rows[0].id],
      );
      return res.json(updated.rows[0]);
    }

    const effectivePrice = productRow.sale_price ?? productRow.price;

    const newCartItem = await pool.query(
      "INSERT INTO cart (user_id, product_id, quantity, original_price, price) VALUES ($1, $2, $3, $4, $5) RETURNING id, quantity, original_price, price, created_at",
      [req.user.id, product_id, quantity, productRow.price, effectivePrice],
    );

    res.status(201).json(newCartItem.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// PUT /cart/:productId - Update cart item quantity
router.put("/cart/:productId", authenticateToken, async (req, res) => {
  const { productId } = req.params;
  const quantity = parsePositiveInteger(req.body.quantity);

  if (!quantity) {
    return res.status(400).json({ message: "Valid quantity is required" });
  }

  try {
    const product = await pool.query("SELECT stock FROM products WHERE id = $1", [
      productId,
    ]);

    if (product.rows.length === 0) {
      return res.status(404).json({ message: "Product not found" });
    }
    if (product.rows[0].stock < quantity) {
      return res.status(400).json({ message: "Insufficient stock" });
    }

    const updated = await pool.query(
      "UPDATE cart SET quantity = $1, updated_at = NOW() WHERE user_id = $2 AND product_id = $3 RETURNING id, quantity, updated_at",
      [quantity, req.user.id, productId],
    );

    if (updated.rows.length === 0) {
      return res.status(404).json({ message: "Product not in cart" });
    }

    res.json(updated.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /cart/:productId - Remove product from cart
router.delete("/cart/:productId", authenticateToken, async (req, res) => {
  const { productId } = req.params;

  try {
    const result = await pool.query(
      "DELETE FROM cart WHERE user_id = $1 AND product_id = $2 RETURNING id",
      [req.user.id, productId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Product not in cart" });
    }

    res.json({ message: "Product removed from cart" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// ============================================================
// Orders Routes
// ============================================================

// GET /orders - Get user's orders
router.get("/orders", authenticateToken, async (req, res) => {
  try {
    const orders = await pool.query(
      `
      SELECT 
        o.id,
        o.status,
        o.total_amount AS total,
        o.payment_status,
        o.payment_method,
        o.created_at,
        'ORD-' || o.id AS order_number,
        a.name as address_name,
        a.phone as address_phone,
        a.address_line1,
        a.address_line2,
        a.city,
        a.state,
        a.country,
        a.pincode
      FROM orders o
      JOIN addresses a ON o.address_id = a.id
      WHERE o.user_id = $1
      ORDER BY o.created_at DESC
      `,
      [req.user.id]
    );

    const ordersWithItems = await Promise.all(
      orders.rows.map(async (order) => {
        const items = await pool.query(
          `
          SELECT 
            oi.quantity,
            oi.price_snapshot AS price,
            oi.product_name_snapshot AS name,
            p.slug AS product_slug
          FROM order_items oi
          JOIN products p ON oi.product_id = p.id
          WHERE oi.order_id = $1
          `,
          [order.id]
        );

        return {
          ...order,
          items: items.rows
        };
      })
    );

    res.json(ordersWithItems);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /orders - Create new order
router.post("/orders", authenticateToken, async (req, res) => {
  const { address_id, payment_method = "cod", items } = req.body;

  if (!address_id || !Array.isArray(items) || items.length === 0) {
    return res
      .status(400)
      .json({ message: "Address ID and items are required" });
  }
  if (!VALID_PAYMENT_METHODS.has(payment_method)) {
    return res.status(400).json({ message: "Invalid payment method" });
  }

  const normalizedItems = items.map((item) => ({
    product_id: item?.product_id,
    quantity: parsePositiveInteger(item?.quantity),
  }));

  if (
    normalizedItems.some(
      (item) => !item.product_id || !item.quantity,
    )
  ) {
    return res.status(400).json({ message: "Each item needs product_id and valid quantity" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Verify address belongs to user
    const address = await client.query(
      "SELECT id FROM addresses WHERE id = $1 AND user_id = $2",
      [address_id, req.user.id],
    );
    if (address.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid address" });
    }

    // Calculate total and verify items while locking product rows for stock safety
    let totalAmount = 0;
    const itemSnapshots = [];

    for (const item of normalizedItems) {
      const product = await client.query(
        "SELECT id, name, price, stock FROM products WHERE id = $1 FOR UPDATE",
        [item.product_id],
      );
      if (product.rows.length === 0) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ message: `Product ${item.product_id} not found` });
      }
      if (product.rows[0].stock < item.quantity) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          message: `Insufficient stock for product ${item.product_id}`,
        });
      }

      totalAmount += product.rows[0].price * item.quantity;
      itemSnapshots.push({
        product_id: product.rows[0].id,
        quantity: item.quantity,
        price: product.rows[0].price,
        name: product.rows[0].name,
      });
    }

    // Create order
    const newOrder = await client.query(
      "INSERT INTO orders (user_id, total_amount, payment_method, address_id) VALUES ($1, $2, $3, $4) RETURNING id",
      [req.user.id, totalAmount, payment_method, address_id],
    );

    // Add order items
    for (const item of itemSnapshots) {
      await client.query(
        "INSERT INTO order_items (order_id, product_id, quantity, price_snapshot, product_name_snapshot) VALUES ($1, $2, $3, $4, $5)",
        [
          newOrder.rows[0].id,
          item.product_id,
          item.quantity,
          item.price,
          item.name,
        ],
      );

      // Update stock
      await client.query("UPDATE products SET stock = stock - $1 WHERE id = $2", [
        item.quantity,
        item.product_id,
      ]);

      // Cleanup successfully purchased item from cart for this user
      await client.query(
        "DELETE FROM cart WHERE user_id = $1 AND product_id = $2",
        [req.user.id, item.product_id],
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      message: "Order created successfully",
      order_id: newOrder.rows[0].id,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

// GET /orders/:id - Get order details
router.get("/orders/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const order = await pool.query(
      `
      SELECT o.id, o.status, o.total_amount, o.payment_status, o.payment_method, o.created_at,
             a.name as address_name, a.phone as address_phone, a.address_line1, a.address_line2,
             a.city, a.state, a.country, a.pincode
      FROM orders o
      JOIN addresses a ON o.address_id = a.id
      WHERE o.id = $1 AND o.user_id = $2
      `,
      [id, req.user.id],
    );

    if (order.rows.length === 0) {
      return res.status(404).json({ message: "Order not found" });
    }

    const items = await pool.query(
      `
      SELECT oi.quantity, oi.price_snapshot, oi.product_name_snapshot,
             p.slug as product_slug
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = $1
      `,
      [id],
    );

    res.json({ ...order.rows[0], items: items.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
