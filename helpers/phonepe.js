const crypto = require("crypto");

function getPhonePeConfig() {
  const merchantId = process.env.PHONEPE_MERCHANT_ID;
  const saltKey = process.env.PHONEPE_SALT_KEY;
  const saltIndex = process.env.PHONEPE_SALT_INDEX;
  const env = process.env.PHONEPE_ENV || "sandbox";

  if (!merchantId || !saltKey || !saltIndex) {
    throw new Error(
      "PhonePe config missing. Set PHONEPE_MERCHANT_ID, PHONEPE_SALT_KEY, PHONEPE_SALT_INDEX",
    );
  }

  const baseUrl =
    process.env.PHONEPE_BASE_URL ||
    (env === "production"
      ? "https://api.phonepe.com/apis/hermes"
      : "https://api-preprod.phonepe.com/apis/pg-sandbox");
      // NOTE : THIS IS FOR TESTING PURPOSES. FOR PRODUCTION, THE URL SHOULD BE https://api.phonepe.com/apis/hermes
      // https://api.phonepe.com/apis/hermes

  return {
    merchantId,
    saltKey,
    saltIndex,
    baseUrl: baseUrl.replace(/\/$/, ""),
  };
}

function createXVerify(payloadOrPath, saltKey, saltIndex) {
  const hash = crypto
    .createHash("sha256")
    .update(`${payloadOrPath}${saltKey}`)
    .digest("hex");
  return `${hash}###${saltIndex}`;
}

function encodeRequestBody(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

async function initiatePhonePePayment({
  merchantTransactionId,
  merchantUserId,
  amount,
  redirectUrl,
  callbackUrl,
  mobileNumber,
}) {
  const { merchantId, saltKey, saltIndex, baseUrl } = getPhonePeConfig();
  const endpointPath = "/pg/v1/pay";
  const endpoint = `${baseUrl}${endpointPath}`;

  const payload = {
    merchantId,
    merchantTransactionId,
    merchantUserId,
    amount,
    redirectUrl,
    redirectMode: "REDIRECT",
    callbackUrl,
    paymentInstrument: {
      type: "PAY_PAGE",
    },
  };

  if (mobileNumber) {
    payload.mobileNumber = mobileNumber;
  }

  const base64Payload = encodeRequestBody(payload);
  const xVerify = createXVerify(base64Payload + endpointPath, saltKey, saltIndex);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-VERIFY": xVerify,
      "X-MERCHANT-ID": merchantId,
    },
    body: JSON.stringify({ request: base64Payload }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data?.success) {
    const message = data?.message || "PhonePe payment initiation failed";
    throw new Error(message);
  }

  const checkoutUrl = data?.data?.instrumentResponse?.redirectInfo?.url;
  if (!checkoutUrl) {
    throw new Error("PhonePe did not return redirect URL");
  }

  return {
    checkoutUrl,
    raw: data,
  };
}

async function getPhonePeStatus(merchantTransactionId) {
  const { merchantId, saltKey, saltIndex, baseUrl } = getPhonePeConfig();
  const endpointPath = `/pg/v1/status/${merchantId}/${merchantTransactionId}`;
  const endpoint = `${baseUrl}${endpointPath}`;
  const xVerify = createXVerify(endpointPath, saltKey, saltIndex);

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-VERIFY": xVerify,
      "X-MERCHANT-ID": merchantId,
    },
  });

  const data = await response.json().catch(() => ({}));

  const normalizedMessage = String(data?.message || "").toLowerCase();
  const hasFailedMessage = normalizedMessage.includes("payment failed");

  if (hasFailedMessage) {
    return {
      ...data,
      success: true,
      data: {
        ...(data?.data || {}),
        state: "FAILED",
      },
    };
  }

  if (!response.ok || data?.success === false) {
    const message = data?.message || "Failed to fetch PhonePe payment status";
    throw new Error(message);
  }

  return data;
}

module.exports = {
  initiatePhonePePayment,
  getPhonePeStatus,
};
