const jwt = require("jsonwebtoken");
const { getRole } = require("./getrole"); // adjust path if needed

async function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: "Authorization header missing" });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "Token missing" });
  }

  try {
    // verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    // check role
    const role = await getRole(decoded.id);

    if (role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    next();
  } catch (err) {
    return res.status(403).json({ message: "Invalid or expired token. Login Again." });
  }
}

module.exports = { authenticateAdmin };
