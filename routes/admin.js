const express = require("express");
const { authenticateAdmin } = require("../helpers/authenticateAdmin");
const pool = require("../db");

const router = express.Router();

// GET /dashboard
router.get("/dashboard", authenticateAdmin, async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM orders) AS total_orders,
        (SELECT COUNT(*) FROM orders WHERE DATE(created_at) = CURRENT_DATE) AS orders_today,
        (SELECT COUNT(*) FROM orders WHERE date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)) AS orders_this_month,

        (SELECT COUNT(*) FROM orders WHERE status = 'delivered') AS fulfilled_orders,
        (SELECT COUNT(*) FROM orders WHERE status = 'pending') AS pending_orders,
        (SELECT COUNT(*) FROM orders WHERE status = 'out_for_delivery') AS in_delivery,

        (SELECT COALESCE(SUM(total_amount),0) FROM orders WHERE payment_status = 'paid') AS total_revenue,
        (SELECT COALESCE(SUM(total_amount),0)
         FROM orders
         WHERE payment_status='paid'
         AND date_trunc('month', created_at)=date_trunc('month', CURRENT_DATE)
        ) AS revenue_this_month,

        (SELECT COUNT(*) FROM products) AS total_products,
        (SELECT COUNT(*) FROM products WHERE stock = 0) AS out_of_stock
    `);

    res.json(stats.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Dashboard error" });
  }
});

// GET /orders
router.get("/orders", authenticateAdmin, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  try {
    const orders = await pool.query(
      `
      SELECT 
        o.id,
        'ORD-' || o.id AS order_number,
        o.status,
        o.total_amount AS total,
        o.created_at,
        u.full_name AS customer_name
      FROM orders o
      JOIN users u ON o.user_id = u.id
      ORDER BY o.created_at DESC
      LIMIT $1 OFFSET $2
      `,
      [limit, offset],
    );

    const count = await pool.query(`SELECT COUNT(*) FROM orders`);

    res.json({
      data: orders.rows,
      total: parseInt(count.rows[0].count),
      page,
      limit,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching orders" });
  }
});

// GET /orders/:id
router.get("/orders/:id", authenticateAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const order = await pool.query(
      `
      SELECT 
        o.*,
        u.full_name AS customer_name,
        u.email
      FROM orders o
      JOIN users u ON o.user_id = u.id
      WHERE o.id = $1
      `,
      [id],
    );

    const items = await pool.query(
      `
      SELECT 
        product_name_snapshot AS name,
        quantity,
        price_snapshot AS price
      FROM order_items
      WHERE order_id = $1
      `,
      [id],
    );

    res.json({
      ...order.rows[0],
      items: items.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching order" });
  }
});

router.post("/orders/manual", authenticateAdmin, async (req, res) => {
  const { user_id, address_id, items } = req.body;

  try {
    let total = 0;

    for (const item of items) {
      const product = await pool.query(
        "SELECT name, price FROM products WHERE id=$1",
        [item.product_id],
      );

      total += product.rows[0].price * item.quantity;
    }

    const order = await pool.query(
      `
      INSERT INTO orders (user_id, address_id, total_amount)
      VALUES ($1,$2,$3)
      RETURNING *
      `,
      [user_id, address_id, total],
    );

    for (const item of items) {
      const product = await pool.query(
        "SELECT name, price FROM products WHERE id=$1",
        [item.product_id],
      );

      await pool.query(
        `
        INSERT INTO order_items
        (order_id, product_id, quantity, price_snapshot, product_name_snapshot)
        VALUES ($1,$2,$3,$4,$5)
        `,
        [
          order.rows[0].id,
          item.product_id,
          item.quantity,
          product.rows[0].price,
          product.rows[0].name,
        ],
      );
    }

    res.json(order.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Manual order failed" });
  }
});

router.put("/orders/:id", authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    const updated = await pool.query(
      `
      UPDATE orders
      SET status=$1
      WHERE id=$2
      RETURNING *
      `,
      [status, id],
    );

    res.json(updated.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Status update failed" });
  }
});

router.post("/manual-order", async (req, res) => {
  const client = await pool.connect();

  try {
    const { user_id, email, address, items } = req.body;

    console.log("Received manual order request:", {
      user_id,
      email,
      address,
      items,
    });

    // 🔒 Basic validation
    if (!items || items.length === 0) {
      return res.status(400).json({ message: "No items provided" });
    }

    if (!user_id && !email) {
      return res.status(400).json({
        message: "Either user_id or email is required",
      });
    }

    if (!address) {
      return res.status(400).json({
        message: "Address is required",
      });
    }

    await client.query("BEGIN");

    // 🧠 Resolve user
    let finalUserId = user_id;

    if (!finalUserId && email) {
      const userRes = await client.query(
        `INSERT INTO users (full_name, email, password_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (email)
     DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
        ["Guest User", email, "manual_order_no_password"],
      );

      finalUserId = userRes.rows[0]?.id;
    }

    // 🚨 HARD SAFETY CHECK
    if (!finalUserId) {
      throw new Error("user_id is required but missing");
    }

    // 🏠 2. Create address
    const addressRes = await client.query(
      `INSERT INTO addresses (
        user_id, name, phone, address_line1, city, state, pincode
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id`,
      [
        finalUserId,
        address.name,
        address.phone,
        address.address_line1,
        address.city,
        address.state,
        address.pincode,
      ],
    );

    const addressId = addressRes.rows[0].id;

    // 📦 3. Get product details
    const productIds = items.map((i) => i.product_id);

    const productsRes = await client.query(
      `SELECT id, name, price, sale_price, stock
       FROM products
       WHERE id = ANY($1::uuid[])`,
      [productIds],
    );

    const productsMap = new Map();
    productsRes.rows.forEach((p) => {
      productsMap.set(p.id, p);
    });

    // 💰 4. Calculate total + validate stock
    let total = 0;

    for (const item of items) {
      const product = productsMap.get(item.product_id);

      if (!product) {
        throw new Error(`Product not found: ${item.product_id}`);
      }

      if (product.stock < item.quantity) {
        throw new Error(`Insufficient stock for ${product.name}`);
      }

      const price = Number(product.sale_price ?? product.price);

      total += price * item.quantity;
    }

    // 🧾 5. Create order
    const orderRes = await client.query(
      `INSERT INTO orders (
        user_id, total_amount, address_id
      )
      VALUES ($1,$2,$3)
      RETURNING id`,
      [finalUserId, total, addressId],
    );

    const orderId = orderRes.rows[0].id;

    // 🧩 6. Insert order items
    for (const item of items) {
      const product = productsMap.get(item.product_id);
      const price = Number(product.sale_price ?? product.price);

      await client.query(
        `INSERT INTO order_items (
          order_id, product_id, quantity,
          price_snapshot, product_name_snapshot
        )
        VALUES ($1,$2,$3,$4,$5)`,
        [orderId, product.id, item.quantity, price, product.name],
      );

      // 📉 Reduce stock
      await client.query(
        `UPDATE products
         SET stock = stock - $1
         WHERE id = $2`,
        [item.quantity, product.id],
      );
    }

    await client.query("COMMIT");

    return res.json({
      message: "Manual order created successfully",
      order_id: orderId,
      total,
    });
  } catch (err) {
    await client.query("ROLLBACK");

    return res.status(500).json({
      message: "Failed to create order",
      error: err.message,
    });
  } finally {
    client.release();
  }
});

// PUT /orders/:id - Update order (status, payment, address)
router.put("/orders/:id", authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  const {
    status,
    payment_status,
    payment_method,
    address_id,
  } = req.body;

  try {
    // Check order belongs to user
    const existingOrder = await pool.query(
      "SELECT id FROM orders WHERE id = $1 AND user_id = $2",
      [id, req.user.id]
    );

    if (existingOrder.rows.length === 0) {
      return res.status(404).json({ message: "Order not found" });
    }

    // If updating address → validate ownership
    if (address_id) {
      const address = await pool.query(
        "SELECT id FROM addresses WHERE id = $1 AND user_id = $2",
        [address_id, req.user.id]
      );

      if (address.rows.length === 0) {
        return res.status(400).json({ message: "Invalid address" });
      }
    }

    // Build dynamic update query
    const fields = [];
    const values = [];
    let index = 1;

    if (status) {
      fields.push(`status = $${index++}`);
      values.push(status);
    }

    if (payment_status) {
      fields.push(`payment_status = $${index++}`);
      values.push(payment_status);
    }

    if (payment_method) {
      fields.push(`payment_method = $${index++}`);
      values.push(payment_method);
    }

    if (address_id) {
      fields.push(`address_id = $${index++}`);
      values.push(address_id);
    }

    if (fields.length === 0) {
      return res.status(400).json({ message: "No fields to update" });
    }

    values.push(id);

    const updated = await pool.query(
      `
      UPDATE orders
      SET ${fields.join(", ")}, updated_at = NOW()
      WHERE id = $${index}
      RETURNING *
      `,
      values
    );

    res.json({
      message: "Order updated successfully",
      order: updated.rows[0],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
