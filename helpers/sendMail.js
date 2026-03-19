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
    return true; // TEMP: Skip actual sending for now
    
    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject,
      text,
      html,
    });

    console.log("📨 Mail sent:", info.response);
    return true;
  } catch (error) {
    console.error("❌ Mail error:", error);
    throw new Error("Email sending failed");
  }
}

module.exports = sendMail;