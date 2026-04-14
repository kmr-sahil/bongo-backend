/**
 * Shiprocket Test Mode Helper
 * Provides mock responses for safe testing without affecting client's live account
 */

function isTestModeEnabled() {
  return String(process.env.SHIPROCKET_TEST_MODE || "false").toLowerCase() === "true";
}

function shouldLogPayloads() {
  return String(process.env.SHIPROCKET_TEST_LOG_PAYLOADS || "false").toLowerCase() === "true";
}

function generateMockShiprocketOrderId() {
  // Generate a realistic-looking mock order ID
  return Math.floor(Math.random() * 900000000) + 100000000;
}

function generateMockShipmentId() {
  // Generate a realistic-looking mock shipment ID
  return Math.floor(Math.random() * 9000000) + 1000000;
}

function createMockResponse(payload) {
  const mockOrderId = generateMockShiprocketOrderId();
  const mockShipmentId = generateMockShipmentId();

  return {
    success: true,
    status_code: 200,
    message: "Order placed successfully",
    data: {
      order_id: mockOrderId,
      shipment_id: mockShipmentId,
      status: "success",
      channel_order_id: payload.order_id,
      pickup_location: payload.pickup_location,
      courier_assigned: {
        courier_name: payload.courier_company_id
          ? "Blue Dart (Mock - Fast)"
          : "Shiprocket Default (Mock - Standard)",
        courier_company_id: payload.courier_company_id || 1,
      },
      shiprocket_order_id: mockOrderId,
      cod_amount: payload.cod_amount || 0,
      amount_due: payload.sub_total || 0,
    },
  };
}

function logPayloadSafely(payload, orderId) {
  if (!shouldLogPayloads()) return;

  console.log("\n========================================");
  console.log("🧪 [TEST MODE] Shiprocket Payload Logged");
  console.log("========================================");
  console.log(`Order ID: ${orderId}`);
  console.log(`Order Date: ${payload.order_date}`);
  console.log(`Pickup Location: ${payload.pickup_location}`);
  console.log("\n📦 Customer Info:");
  console.log(`  Name: ${payload.billing_customer_name}`);
  console.log(`  Email: ${payload.billing_email}`);
  console.log(`  Phone: ${payload.billing_phone}`);
  console.log(`  Address: ${payload.billing_address}`);
  console.log(`  City: ${payload.billing_city}, ${payload.billing_state} - ${payload.billing_pincode}`);
  
  console.log("\n🛍️  Items:");
  payload.order_items.forEach((item, idx) => {
    console.log(`  ${idx + 1}. ${item.name}`);
    console.log(`     SKU: ${item.sku} | Units: ${item.units} | Price: ₹${item.selling_price}`);
  });

  console.log("\n💰 Payment Details:");
  console.log(`  Subtotal: ₹${payload.sub_total}`);
  console.log(`  Shipping: ₹${payload.shipping_charges}`);
  console.log(`  Payment Method: ${payload.payment_method}`);
  if (payload.cod_amount > 0) {
    console.log(`  COD Amount: ₹${payload.cod_amount}`);
  }
  console.log(`  Courier Company ID: ${payload.courier_company_id || "Auto-selected"}`);
  console.log("========================================\n");
}

async function mockShiprocketApiCall(payload, orderId) {
  logPayloadSafely(payload, orderId);

  return {
    ok: true,
    status: 200,
    json: async () => createMockResponse(payload),
  };
}

module.exports = {
  isTestModeEnabled,
  shouldLogPayloads,
  generateMockShiprocketOrderId,
  generateMockShipmentId,
  createMockResponse,
  logPayloadSafely,
  mockShiprocketApiCall,
};
