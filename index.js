const express = require("express");
require("dotenv").config();
const cors = require("cors");
const cookieParser = require("cookie-parser");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(cookieParser());
app.use(express.json());

// Main router
const authRouter = require("./routes/auth");
const profileRouter = require("./routes/profile");
const productsRouter = require("./routes/products");
const categoriesRouter = require("./routes/category");
const ordersRouter = require("./routes/cart");
const adminRouter = require("./routes/admin");
const blogsRouter = require("./routes/blogs");
const extras = require("./routes/extras");
const checkoutRouter = require("./routes/checkout");
require("./Schedulers/abadonCardScheduler");

app.use("/api/auth", authRouter);
app.use("/profile", profileRouter);
app.use("/products", productsRouter);
app.use("/api/categories", categoriesRouter);
app.use("/store", ordersRouter);
app.use("/store/admin", adminRouter);
app.use("/blogs", blogsRouter);
app.use("/extras", extras);
app.use("/checkout", checkoutRouter);

app.get("/", (req, res) => {
  res.send("Server is running");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
