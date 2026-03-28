const express = require("express");
const sendMail = require("../helpers/sendMail");
const pool = require("../db");

const router = express.Router();

router.post("/contact", async (req, res) => {
  try {
    const { name, email, phone, subject, message } = req.body;

    // Basic validation
    if (!name || !email || !subject || !message) {
      return res.status(400).json({
        success: false,
        message: "Required fields missing",
      });
    }

    const to = "info@bongohridoy.com"; // your receiving email

    const text = `
New Contact Form Submission

Name: ${name}
Email: ${email}
Phone: ${phone || "N/A"}
Subject: ${subject}

Message:
${message}
    `;

    const html = `
      <h2>New Contact Message</h2>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Phone:</strong> ${phone || "N/A"}</p>
      <p><strong>Subject:</strong> ${subject}</p>
      <p><strong>Message:</strong></p>
      <p>${message}</p>
    `;

    console

    await sendMail({
      to,
      subject: `Contact: ${subject}`,
      text,
      html,
    });

    return res.status(200).json({
      success: true,
      message: "Message sent successfully",
    });
  } catch (error) {
    console.error("Contact Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
});

router.post("/newsletter", async (req, res) => {
  const { email } = req.body;

  // 🧪 Basic validation
  if (!email) {
    return res.status(400).json({
      message: "Email is required",
      code: "EMAIL_REQUIRED",
    });
  }

  try {
    // 🔍 Check if already exists
    const existing = await pool.query(
      "SELECT * FROM newsletters WHERE email = $1",
      [email]
    );

    // 👀 If user already exists
    if (existing.rows.length > 0) {
      const user = existing.rows[0];

      // 🟢 Already subscribed
      if (user.is_subscribed) {
        return res.status(200).json({
          message: "Already subscribed",
          code: "ALREADY_SUBSCRIBED",
        });
      }

      // 🔁 Resubscribe flow
      await pool.query(
        `UPDATE newsletters 
         SET is_subscribed = true, 
             unsubscribed_at = NULL,
             updated_at = NOW()
         WHERE email = $1`,
        [email]
      );

      return res.status(200).json({
        message: "Subscribed again successfully",
        code: "RESUBSCRIBED",
      });
    }

    // 🆕 New user
    await pool.query(
      `INSERT INTO newsletters (email) 
       VALUES ($1)`,
      [email]
    );

    return res.status(201).json({
      message: "Subscribed successfully",
      code: "SUBSCRIBED",
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: "Server error",
      code: "SERVER_ERROR",
    });
  }
});

module.exports = router;
