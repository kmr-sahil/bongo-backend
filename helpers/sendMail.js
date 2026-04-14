const nodemailer = require("nodemailer");

// transporter lives here now 🧠
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

/**
 * sendMail function
 * @param {Object} options
 * @param {string} options.to
 * @param {string} options.subject
 * @param {string} options.text
 * @param {string} [options.html]
 */
async function sendMail({ to, subject, text, html }) {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      throw new Error("EMAIL_USER and EMAIL_PASS must be configured");
    }

    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject,
      text,
      html,
    });

    return true;
  } catch (error) {
    console.error("❌ Mail error:", error);
    throw new Error("Email sending failed");
  }
}

module.exports = sendMail;