const express = require("express");
const { authenticateToken } = require("../helpers/middleware");
const pool = require("../db");
const {
  initiatePhonePePayment,
  getPhonePeStatus,
} = require("../helpers/phonepe");

const router = express.Router();

const DEFAULT_PRODUCT_WEIGHT_KG = Number(
  process.env.DEFAULT_PRODUCT_WEIGHT_KG || 0.5,
);
const SHIPROCKET_KEY_MAX_AGE_MS = 24 * 60 * 60 * 1000 * 10;

function orderIdToMerchantTxnId(orderId) {
  return orderId.replace(/-/g, "");
}

function merchantTxnIdToOrderId(merchantTransactionId) {
  if (!/^[a-fA-F0-9]{32}$/.test(merchantTransactionId)) {
    return null;
  }

  return `${merchantTransactionId.slice(0, 8)}-${merchantTransactionId.slice(8, 12)}-${merchantTransactionId.slice(12, 16)}-${merchantTransactionId.slice(16, 20)}-${merchantTransactionId.slice(20)}`;
}

function mapPhonePeStateToPaymentStatus(state) {
  if (state === "COMPLETED") return "paid";
  if (state === "FAILED") return "failed";
  return "pending";
}

function mapStatusErrorToState(error) {
  const message = String(error?.message || "").toLowerCase();

  if (message.includes("payment failed") || message.includes("failed")) {
    return "FAILED";
  }

  if (message.includes("pending")) {
    return "PENDING";
  }

  return null;
}

function normalizeOrderItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  const normalizedItems = [];
  for (const item of items) {
    const quantity = Number(item?.quantity);
    if (!item?.product_id || !Number.isFinite(quantity) || quantity < 1) {
      return null;
    }

    normalizedItems.push({
      product_id: item.product_id,
      quantity: Math.floor(quantity),
    });
  }

  return normalizedItems;
}

function parseWeightToKg(rawWeight) {
  if (rawWeight === null || rawWeight === undefined) {
    return null;
  }

  if (typeof rawWeight === "number") {
    if (!Number.isFinite(rawWeight) || rawWeight <= 0) return null;
    return rawWeight;
  }

  const weightString = String(rawWeight).trim().toLowerCase();
  if (!weightString) return null;

  const match = weightString.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  if (weightString.includes("kg")) return value;
  if (
    weightString.includes("gm") ||
    weightString.includes("gram") ||
    weightString.includes("g")
  )
    return value / 1000;

  if (value > 20) return value / 1000;
  return value;
}

function buildCourierOptionCode(courier, index) {
  const courierCompanyId = courier?.courier_company_id ?? "na";
  const courierId = courier?.id ?? index;
  return `courier_${courierCompanyId}_${courierId}_${index}`;
}

function toCourierOption(courier, index) {
  const charge = Number(
    courier?.freight_charge ??
      courier?.rate ??
      courier?.total_charge ??
      courier?.cod_charges ??
      0,
  );

  const estimatedDaysRaw = Number(
    courier?.estimated_delivery_days ??
      courier?.delivery_days ??
      courier?.etd_days ??
      0,
  );

  return {
    code: buildCourierOptionCode(courier, index),
    type: "courier",
    label: courier?.courier_name || "Courier Delivery",
    courier_name: courier?.courier_name || "Unknown Courier",
    courier_company_id: courier?.courier_company_id ?? null,
    rate: Number.isFinite(charge) ? Math.max(0, charge) : 0,
    etd: courier?.etd || null,
    charge: Number.isFinite(charge) ? Math.max(0, charge) : 0,
    estimated_delivery_days:
      Number.isFinite(estimatedDaysRaw) && estimatedDaysRaw > 0
        ? estimatedDaysRaw
        : null,
    estimated_delivery_text: courier?.etd || null,
  };
}

function getCourierCharge(courier) {
  const value = Number(
    courier?.freight_charge ??
      courier?.rate ??
      courier?.total_charge ??
      Number.MAX_SAFE_INTEGER,
  );

  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function getPackageDimensions(weightKg) {
  if (Number(weightKg) > 2) {
    return { length: 30, breadth: 30, height: 20 };
  }

  return { length: 15, breadth: 10, height: 5 };
}

function buildDeliveryOptions(rawCourierList, { isCod = false } = {}) {
  let courierList = Array.isArray(rawCourierList) ? rawCourierList : [];
  if (isCod) {
    courierList = courierList.filter((courier) => Number(courier?.cod) === 1);
  }

  if (!courierList.length) {
    return [];
  }

  const sortedByPrice = [...courierList].sort((a, b) => {
    return getCourierCharge(a) - getCourierCharge(b);
  });

  return sortedByPrice.map((courier, index) => toCourierOption(courier, index));
}

async function updateOrderPaymentState(orderId, paymentStatus) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existingOrderResult = await client.query(
      "SELECT id, user_id, payment_status FROM orders WHERE id = $1 FOR UPDATE",
      [orderId],
    );

    if (existingOrderResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const existingOrder = existingOrderResult.rows[0];
    const currentPaymentStatus = existingOrder.payment_status;
    const nextPaymentStatus =
      (currentPaymentStatus === "paid" || currentPaymentStatus === "failed") &&
      paymentStatus === "pending"
        ? currentPaymentStatus
        : paymentStatus;
    const isTransitionToPaid =
      nextPaymentStatus === "paid" && currentPaymentStatus !== "paid";

    if (isTransitionToPaid) {
      const orderItemsResult = await client.query(
        "SELECT product_id, quantity FROM order_items WHERE order_id = $1",
        [orderId],
      );

      for (const orderItem of orderItemsResult.rows) {
        const stockUpdateResult = await client.query(
          `UPDATE products
           SET stock = stock - $1
           WHERE id = $2 AND stock >= $1
           RETURNING id`,
          [orderItem.quantity, orderItem.product_id],
        );

        if (stockUpdateResult.rows.length === 0) {
          throw new Error(
            `Insufficient stock for product ${orderItem.product_id} at payment confirmation`,
          );
        }

        await client.query(
          "DELETE FROM cart WHERE user_id = $1 AND product_id = $2",
          [existingOrder.user_id, orderItem.product_id],
        );
      }
    }

    const result = await client.query(
      `
		UPDATE orders
		SET
			payment_status = $1::payment_status,
			status = CASE
				WHEN $1::payment_status = 'paid'::payment_status THEN 'confirmed'::order_status
				WHEN $1::payment_status = 'failed'::payment_status THEN 'cancelled'::order_status
				ELSE status
			END
		WHERE id = $2
		RETURNING id, status, payment_status
		`,
    [nextPaymentStatus, orderId],
    );

    await client.query("COMMIT");
    return result.rows[0] || null;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // Rollback failed, continue with error handling.
    }

    throw error;
  } finally {
    client.release();
  }
}

async function genrateNewApiKeyShiprocket() {
  const email = String(
    process.env.SHIPROCKET_USER_EMAIL || process.env.SHIPROCKET_USER_GMAIL || "",
  ).trim();
  const password = String(process.env.SHIPROCKET_USER_PASSWORD || "").trim();
  if (!email || !password) {
    throw new Error("Shiprocket credentials are not configured");
  }

  const response = await fetch(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    },
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Shiprocket API error: ${data.message || response.statusText}`,
    );
  }

  const apiKey = data?.token;

  if (!apiKey) {
    throw new Error("API key not found in Shiprocket response");
  }

  await pool.query(
    `INSERT INTO shiprocket_key (id, shiprocket_key)
     VALUES (1, $1)
     ON CONFLICT (id)
     DO UPDATE SET shiprocket_key = EXCLUDED.shiprocket_key`,
    [apiKey],
  );

  return apiKey;
}

function isShiprocketApiKeyValid(apiKeyRow) {
  if (!apiKeyRow?.shiprocket_key || !apiKeyRow?.updated_at) {
    return false;
  }

  const updatedAtMs = new Date(apiKeyRow.updated_at).getTime();
  if (!Number.isFinite(updatedAtMs)) {
    return false;
  }

  return Date.now() - updatedAtMs <= SHIPROCKET_KEY_MAX_AGE_MS;
}

async function getLatestShiprocketApiKeyRow() {
  const apiKeyData = await pool.query(
    "SELECT shiprocket_key, updated_at FROM shiprocket_key ORDER BY updated_at DESC LIMIT 1",
  );

  return apiKeyData.rows[0] || null;
}

async function getShiprocketApiKey({
  forceRefresh = false,
  allowExpiredFallback = true,
} = {}) {
  try {
    const latestKey = await getLatestShiprocketApiKeyRow();

    if (!forceRefresh && isShiprocketApiKeyValid(latestKey)) {
      return latestKey.shiprocket_key;
    }

    const newApiKey = await genrateNewApiKeyShiprocket();
    if (!newApiKey) {
      throw new Error("Shiprocket API key unavailable");
    }

    return newApiKey;
  } catch (e) {
    if (!forceRefresh && allowExpiredFallback) {
      const latestKey = await getLatestShiprocketApiKeyRow();
      if (latestKey?.shiprocket_key) {
        console.warn(
          "[Shiprocket API] Re-auth failed, using last stored token as fallback",
        );
        return latestKey.shiprocket_key;
      }
    }

    console.error("Error fetching Shiprocket API key:", e);
    throw e;
  }
}

async function requestShiprocketServiceability(url, apiKey) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const data = await response.json();
  return { response, data };
}

async function fetchShiprocketServiceability({
  pickupPincode,
  deliveryPincode,
  weight,
  isCod,
  dimensions,
}) {
  const apiKey = await getShiprocketApiKey({ allowExpiredFallback: true });
  if (!apiKey) {
    throw new Error("Shiprocket API key unavailable");
  }

  const cod = isCod ? 1 : 0;
  const length = Number(dimensions?.length) || 15;
  const breadth = Number(dimensions?.breadth) || 10;
  const height = Number(dimensions?.height) || 5;

  const url = `https://apiv2.shiprocket.in/v1/external/courier/serviceability/?pickup_postcode=${pickupPincode}&delivery_postcode=${deliveryPincode}&weight=${weight}&cod=${cod}&length=${length}&breadth=${breadth}&height=${height}`;

  let { response, data } = await requestShiprocketServiceability(url, apiKey);

  if (response.status === 401 || response.status === 403) {
    console.warn(
      "[Shiprocket API] Received unauthorized response, attempting token refresh and retry",
    );

    const freshApiKey = await getShiprocketApiKey({
      forceRefresh: true,
      allowExpiredFallback: false,
    });

    ({ response, data } = await requestShiprocketServiceability(url, freshApiKey));
  }

  if (!response.ok) {
    throw new Error(
      data?.message || `Shiprocket error: ${response.statusText}`,
    );
  }

  return data;
}

async function resolveAddressPincode(userId, addressId) {
  const addressResult = await pool.query(
    "SELECT id, pincode FROM addresses WHERE id = $1 AND user_id = $2",
    [addressId, userId],
  );

  if (addressResult.rows.length === 0) {
    return null;
  }

  return addressResult.rows[0];
}

async function sumOrderWeightKg(items) {
  let totalWeightKg = 0;

  for (const item of items) {
    const productResult = await pool.query(
      "SELECT id, weight FROM products WHERE id = $1",
      [item.product_id],
    );

    if (productResult.rows.length === 0) {
      throw new Error(`Product ${item.product_id} not found`);
    }

    const parsedWeight = parseWeightToKg(productResult.rows[0].weight);
    const unitWeightKg = parsedWeight ?? DEFAULT_PRODUCT_WEIGHT_KG;
    totalWeightKg += unitWeightKg * item.quantity;
  }

  return Number(totalWeightKg.toFixed(3));
}

async function getDeliveryOptionsForOrder({ items, deliveryPincode, isCod }) {
  const senderPincode = process.env.SENDER_PINCODE;
  if (!senderPincode) {
    throw new Error("SENDER_PINCODE is not configured");
  }

  const totalWeightKg = await sumOrderWeightKg(items);
  const weightForRate = Math.max(0.1, totalWeightKg);
  const dimensions = getPackageDimensions(weightForRate);

  const shiprocketData = await fetchShiprocketServiceability({
    pickupPincode: senderPincode,
    deliveryPincode,
    weight: weightForRate,
    isCod,
    dimensions,
  });

  const courierList =
    shiprocketData?.data?.available_courier_companies ||
    shiprocketData?.available_courier_companies ||
    [];

  const options = buildDeliveryOptions(courierList, { isCod });

  if (!options.length) {
    throw new Error("No courier options available for this pincode");
  }

  return {
    pincode: deliveryPincode,
    total_weight_kg: weightForRate,
    dimensions,
    options,
  };
}

// Get available payment methods (public endpoint)
router.get("/payment-methods", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, payment_method, notes FROM available_payment_method WHERE is_available = true ORDER BY id`,
    );
    res.status(200).json(result.rows);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// GET /checkout/product-delivery-check?pincode=700001&product_id=<uuid>&quantity=1&cod=0
router.get("/product-delivery-check", async (req, res) => {
  const { pincode, product_id, quantity = 1, cod = 0 } = req.query;

  const deliveryPincode = String(pincode || "").trim();
  const productId = String(product_id || "").trim();
  const qty = Number.parseInt(String(quantity), 10);
  const isCod = String(cod) === "1";

  if (!/^\d{6}$/.test(deliveryPincode)) {
    return res.status(400).json({ message: "Valid 6-digit pincode is required" });
  }

  if (!productId) {
    return res.status(400).json({ message: "product_id is required" });
  }

  if (!Number.isInteger(qty) || qty < 1) {
    return res.status(400).json({ message: "Valid quantity is required" });
  }

  try {
    const productResult = await pool.query(
      "SELECT id, name, stock FROM products WHERE id = $1 AND is_visible = TRUE",
      [productId],
    );

    if (productResult.rows.length === 0) {
      return res.status(404).json({ message: "Product not found" });
    }

    const product = productResult.rows[0];

    if (Number(product.stock) < qty) {
      return res.status(200).json({
        delivery_available: false,
        delivery_time_days: 0,
        message: "Product is out of stock",
      });
    }

    const deliveryData = await getDeliveryOptionsForOrder({
      items: [{ product_id: productId, quantity: qty }],
      deliveryPincode,
      isCod,
    });

    const firstOption = deliveryData.options[0] || null;
    const days = Number(firstOption?.estimated_delivery_days ?? 0);

    return res.status(200).json({
      delivery_available: deliveryData.options.length > 0,
      delivery_time_days: Number.isFinite(days) && days > 0 ? days : 0,
      options: deliveryData.options,
      selected_default_code: firstOption?.code || null,
      pincode: deliveryPincode,
    });
  } catch (error) {
    console.error("[Checkout] Product delivery check error:", error);
    return res.status(500).json({
      delivery_available: false,
      delivery_time_days: 0,
      message: error.message || "Could not check delivery",
    });
  }
});

// POST /checkout/delivery-options
// Body: { address_id, items: [{ product_id, quantity }], payment_gateway?: "phonepe" | "cash_on_delivery" }
router.post("/delivery-options", authenticateToken, async (req, res) => {
  const { address_id, items, payment_gateway = "phonepe" } = req.body;

  const normalizedItems = normalizeOrderItems(items);
  if (!address_id || !normalizedItems) {
    return res
      .status(400)
      .json({ message: "Address and valid items are required" });
  }

  if (!["phonepe", "cash_on_delivery"].includes(payment_gateway)) {
    return res.status(400).json({ message: "Unsupported payment gateway" });
  }

  try {
    const address = await resolveAddressPincode(req.user.id, address_id);
    if (!address) {
      return res.status(400).json({ message: "Invalid address" });
    }

    const deliveryData = await getDeliveryOptionsForOrder({
      items: normalizedItems,
      deliveryPincode: address.pincode,
      isCod: payment_gateway === "cash_on_delivery",
    });

    return res.status(200).json({
      message: "Delivery options fetched",
      selected_default_code: deliveryData.options[0]?.code || null,
      ...deliveryData,
    });
  } catch (error) {
    console.error("[Checkout] Error fetching delivery options:", error);
    return res
      .status(500)
      .json({ message: error.message || "Could not fetch delivery options" });
  }
});

// POST /checkout/initiate
// Body: { address_id, items: [{ product_id, quantity }], payment_gateway: "phonepe" }
router.post("/initiate", authenticateToken, async (req, res) => {
  const {
    address_id,
    items,
    payment_gateway = "phonepe",
    delivery_option_code,
  } = req.body;

  const normalizedItems = normalizeOrderItems(items);

  if (!address_id || !normalizedItems) {
    return res.status(400).json({ message: "Address and items are required" });
  }

  if (!["phonepe", "cash_on_delivery"].includes(payment_gateway)) {
    return res.status(400).json({ message: "Unsupported payment gateway" });
  }

  const isCOD = payment_gateway === "cash_on_delivery";

  let selectedDeliveryOption = null;
  let selectedDeliveryCharge = 0;

  try {
    const address = await resolveAddressPincode(req.user.id, address_id);
    if (!address) {
      return res.status(400).json({ message: "Invalid address" });
    }

    const deliveryData = await getDeliveryOptionsForOrder({
      items: normalizedItems,
      deliveryPincode: address.pincode,
      isCod: isCOD,
    });

    selectedDeliveryOption =
      deliveryData.options.find(
        (option) => option.code === delivery_option_code,
      ) ||
      deliveryData.options[0] ||
      null;

    if (!selectedDeliveryOption) {
      return res.status(400).json({ message: "No delivery option available" });
    }

    selectedDeliveryCharge = Number(selectedDeliveryOption.charge || 0);
  } catch (deliveryError) {
    return res.status(500).json({
      message: deliveryError.message || "Could not fetch delivery charge",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const addressResult = await client.query(
      "SELECT id FROM addresses WHERE id = $1 AND user_id = $2",
      [address_id, req.user.id],
    );

    if (addressResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid address" });
    }

    let itemSubtotal = 0;
    const sanitizedItems = [];

    for (const item of normalizedItems) {
      const productResult = await client.query(
        "SELECT id, name, price, sale_price, stock FROM products WHERE id = $1 FOR UPDATE",
        [item.product_id],
      );

      if (productResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ message: `Product ${item.product_id} not found` });
      }

      const product = productResult.rows[0];
      const quantity = Number(item.quantity);
      const unitPrice = Number(product.sale_price ?? product.price);

      if (product.stock < quantity) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          message: `Insufficient stock for ${product.name}`,
        });
      }

      const lineTotal = unitPrice * quantity;
      itemSubtotal += lineTotal;

      sanitizedItems.push({
        productId: product.id,
        productName: product.name,
        unitPrice,
        quantity,
        lineTotal,
      });
    }

    const totalAmount = itemSubtotal + selectedDeliveryCharge;

    // Determine payment method and status based on gateway
    const dbPaymentMethod = isCOD ? "cod" : "upi";
    const initialPaymentStatus = isCOD ? "pending" : "pending";

    const orderResult = await client.query(
      "INSERT INTO orders (user_id, total_amount, payment_method, payment_status, status, address_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [
        req.user.id,
        totalAmount,
        dbPaymentMethod,
        initialPaymentStatus,
        isCOD ? "confirmed" : "pending",
        address_id,
      ],
    );

    const orderId = orderResult.rows[0].id;

    for (const item of sanitizedItems) {
      await client.query(
        "INSERT INTO order_items (order_id, product_id, quantity, price_snapshot, product_name_snapshot) VALUES ($1, $2, $3, $4, $5)",
        [
          orderId,
          item.productId,
          item.quantity,
          item.unitPrice,
          item.productName,
        ],
      );

      if (isCOD) {
        await client.query(
          "UPDATE products SET stock = stock - $1 WHERE id = $2",
          [item.quantity, item.productId],
        );

        await client.query(
          "DELETE FROM cart WHERE user_id = $1 AND product_id = $2",
          [req.user.id, item.productId],
        );
      }
    }

    await client.query("COMMIT");

    // Handle COD orders - no payment gateway needed
    if (isCOD) {
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

      res.status(201).json({
        message: "Order placed successfully",
        order_id: orderId,
        subtotal: itemSubtotal,
        shipping_charge: selectedDeliveryCharge,
        delivery_charge: selectedDeliveryCharge,
        delivery_option: selectedDeliveryOption,
        total: totalAmount,
        payment_gateway: "cash_on_delivery",
        redirect_url: `${frontendUrl}/account/orders`,
      });
      return;
    }

    // Handle PhonePe orders
    const merchantTransactionId = orderIdToMerchantTxnId(orderId);
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    const backendPublicUrl =
      process.env.BACKEND_PUBLIC_URL ||
      `http://localhost:${process.env.PORT || 3000}`;

    const paymentResult = await initiatePhonePePayment({
      merchantTransactionId,
      merchantUserId: String(req.user.id),
      amount: Math.round(totalAmount * 100),
      redirectUrl: `${frontendUrl}/payment-status?orderId=${orderId}`,
      callbackUrl: `${backendPublicUrl}/checkout/phonepe/callback`,
    });

    res.status(201).json({
      message: "Checkout initiated",
      order_id: orderId,
      subtotal: itemSubtotal,
      shipping_charge: selectedDeliveryCharge,
      delivery_charge: selectedDeliveryCharge,
      delivery_option: selectedDeliveryOption,
      total: totalAmount,
      checkout_url: paymentResult.checkoutUrl,
      payment_gateway: "phonepe",
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // Rollback failed, continue with error handling
    }

    res.status(500).json({
      message: error.message || "Could not initiate checkout",
    });
  } finally {
    client.release();
  }
});

// POST /checkout/phonepe/callback
// PhonePe sends: { response: "<base64 payload>" }
router.post("/phonepe/callback", async (req, res) => {
  try {
    const encodedResponse = req.body?.response;

    if (!encodedResponse) {
      return res.status(400).json({ message: "Missing response payload" });
    }

    const decoded = JSON.parse(
      Buffer.from(encodedResponse, "base64").toString("utf8"),
    );

    const merchantTransactionId =
      decoded?.data?.merchantTransactionId || decoded?.merchantTransactionId;

    if (!merchantTransactionId) {
      return res
        .status(400)
        .json({ message: "merchantTransactionId not found" });
    }

    const orderId = merchantTxnIdToOrderId(merchantTransactionId);
    if (!orderId) {
      return res.status(400).json({ message: "Invalid merchant transaction" });
    }

    let state = "PENDING";
    try {
      const statusResponse = await getPhonePeStatus(merchantTransactionId);
      state = statusResponse?.data?.state || "PENDING";
    } catch (statusError) {
      const fallbackState = mapStatusErrorToState(statusError);
      if (!fallbackState) {
        throw statusError;
      }

      state = fallbackState;
    }

    const paymentStatus = mapPhonePeStateToPaymentStatus(state);

    const updatedOrder = await updateOrderPaymentState(orderId, paymentStatus);

    return res.status(200).json({ message: "Callback processed" });
  } catch (error) {
    return res.status(500).json({ message: "Callback processing failed" });
  }
});

// GET /checkout/status/:orderId
router.get("/status/:orderId", authenticateToken, async (req, res) => {
  const { orderId } = req.params;

  try {
    const orderResult = await pool.query(
      "SELECT id, user_id, status, payment_status FROM orders WHERE id = $1",
      [orderId],
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ message: "Order not found" });
    }

    const order = orderResult.rows[0];
    if (String(order.user_id) !== String(req.user.id)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const merchantTransactionId = orderIdToMerchantTxnId(orderId);
    let state = "PENDING";

    try {
      const statusResponse = await getPhonePeStatus(merchantTransactionId);
      state = statusResponse?.data?.state || "PENDING";
    } catch (statusError) {
      const fallbackState = mapStatusErrorToState(statusError);
      if (!fallbackState) {
        throw statusError;
      }

      state = fallbackState;
    }

    const paymentStatus = mapPhonePeStateToPaymentStatus(state);

    const updatedOrder = await updateOrderPaymentState(orderId, paymentStatus);

    return res.json({
      order_id: orderId,
      order_status: updatedOrder?.status || order.status,
      payment_status: paymentStatus,
      phonepe_state: state,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to check payment status" });
  }
});

router.get("/courier-availability", async (req, res) => {
  const { pincode, weight, cod } = req.query;

  if (!pincode) {
    return res.status(400).json({ message: "Pincode is required" });
  }

  const numericWeight = Number(weight);
  if (!Number.isFinite(numericWeight) || numericWeight <= 0) {
    return res.status(400).json({ message: "Valid weight is required" });
  }

  try {
    const isCodRequest = String(cod || "1") === "1";
    const dimensions = getPackageDimensions(numericWeight);

    const senderPincode = process.env.SENDER_PINCODE;
    if (!senderPincode) {
      return res
        .status(500)
        .json({ message: "SENDER_PINCODE is not configured" });
    }

    const data = await fetchShiprocketServiceability({
      pickupPincode: senderPincode,
      deliveryPincode: String(pincode),
      weight: numericWeight,
      isCod: isCodRequest,
      dimensions,
    });

    const courierList =
      data?.data?.available_courier_companies ||
      data?.available_courier_companies ||
      [];

    const options = buildDeliveryOptions(courierList, { isCod: isCodRequest });

    return res.status(200).json({
      pincode,
      weight: numericWeight,
      dimensions,
      options,
      raw: data,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ message: e.message || "Failed to fetch courier availability" });
  }
});

module.exports = router;
