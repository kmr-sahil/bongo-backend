const express = require("express");
const router = express.Router();
const pool = require("../db");

// GET all blogs
router.get("/", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const countResult = await pool.query("SELECT COUNT(*) FROM blogs");
    const totalCount = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(totalCount / limit);

    const result = await pool.query(
      "SELECT * FROM blogs ORDER BY created_at DESC LIMIT $1 OFFSET $2",
      [limit, offset]
    );

    res.json({
      data: result.rows,
      total_pages: totalPages,
      current_page: page,
      total_count: totalCount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET single blog by ID
router.get("/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const result = await pool.query("SELECT * FROM blogs WHERE slug = $1", [slug]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Blog not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST create new blog
router.post("/", async (req, res) => {
  try {
    const {
      title,
      slug,
      content,
      featured_image,
      meta_title,
      meta_description,
    } = req.body;
    const result = await pool.query(
      "INSERT INTO blogs (title, slug, content, featured_image, meta_title, meta_description) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [title, slug, content, featured_image, meta_title, meta_description],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT update blog by ID
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      slug,
      content,
      featured_image,
      meta_title,
      meta_description,
    } = req.body;
    const result = await pool.query(
      "UPDATE blogs SET title = $1, slug = $2, content = $3, featured_image = $4, meta_title = $5, meta_description = $6, updated_at = NOW() WHERE id = $7 RETURNING *",
      [title, slug, content, featured_image, meta_title, meta_description, id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Blog not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE blog by ID
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "DELETE FROM blogs WHERE id = $1 RETURNING *",
      [id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Blog not found" });
    }
    res.json({ message: "Blog deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
