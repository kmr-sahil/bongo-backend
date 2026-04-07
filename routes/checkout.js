const express = require("express");
const { authenticateToken } = require("../helpers/middleware");
const pool = require("../db");
const {
	initiatePhonePePayment,
	getPhonePeStatus,
} = require("../helpers/phonepe");

const router = express.Router();

const DELIVERY_FREE_THRESHOLD = Number(process.env.DELIVERY_FREE_THRESHOLD || 500);
const DEFAULT_DELIVERY_CHARGE = Number(process.env.DELIVERY_CHARGE || 50);

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

function calculateShipping(itemSubtotal) {
	return itemSubtotal > DELIVERY_FREE_THRESHOLD ? 0 : DEFAULT_DELIVERY_CHARGE;
}

async function updateOrderPaymentState(orderId, paymentStatus) {
	const result = await pool.query(
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
		[paymentStatus, orderId],
	);

	return result.rows[0] || null;
}

// POST /checkout/initiate
// Body: { address_id, items: [{ product_id, quantity }], payment_gateway: "phonepe" }
router.post("/initiate", authenticateToken, async (req, res) => {
	const {
		address_id,
		items,
		subtotal,
		shipping_charge,
		total,
		payment_gateway = "phonepe",
	} = req.body;

	if (!address_id || !Array.isArray(items) || items.length === 0) {
		return res
			.status(400)
			.json({ message: "Address and items are required" });
	}

	if (payment_gateway !== "phonepe") {
		return res
			.status(400)
			.json({ message: "Unsupported payment gateway" });
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

		for (const item of items) {
			if (!item?.product_id || !item?.quantity || item.quantity < 1) {
				await client.query("ROLLBACK");
				return res.status(400).json({ message: "Invalid item payload" });
			}

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

		const computedShipping = calculateShipping(itemSubtotal);
		const totalAmount = itemSubtotal + computedShipping;

		const orderResult = await client.query(
			"INSERT INTO orders (user_id, total_amount, payment_method, payment_status, address_id) VALUES ($1, $2, $3, $4, $5) RETURNING id",
			[req.user.id, totalAmount, "upi", "pending", address_id],
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

			await client.query(
				"UPDATE products SET stock = stock - $1 WHERE id = $2",
				[item.quantity, item.productId],
			);
		}

		await client.query("COMMIT");

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
			shipping_charge: computedShipping,
			total: totalAmount,
			checkout_url: paymentResult.checkoutUrl,
			payment_gateway: "phonepe",
		});
	} catch (error) {
		try {
			await client.query("ROLLBACK");
		} catch (rollbackError) {
			console.error("Rollback failed", rollbackError);
		}

		console.error("[checkout] initiate.error", error);
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
		console.error("[checkout] callback.error", error);
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
		console.error("[checkout] status.error", error);
		return res.status(500).json({ message: "Failed to check payment status" });
	}
});



module.exports = router;