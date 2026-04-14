require("dotenv").config();

const { CronJob } = require("cron");
const pool = require("../db");

const PENDING_ORDER_TIMEOUT_MINUTES =
  Number.parseInt(process.env.PHONEPE_PENDING_TIMEOUT_MINUTES || "30", 10) || 30;
const PENDING_ORDER_CRON_EXPRESSION =
  process.env.PHONEPE_PENDING_ORDER_CRON || "*/30 * * * *";
const CRON_TIMEZONE = process.env.CRON_TIMEZONE || "Asia/Kolkata";

async function expireStalePendingPhonePeOrders() {
  const result = await pool.query(
    `
      UPDATE orders
      SET
        payment_status = 'failed'::payment_status,
        status = 'cancelled'::order_status
      WHERE payment_method = 'upi'
        AND payment_status = 'pending'::payment_status
        AND created_at <= NOW() - ($1::text || ' minutes')::interval
      RETURNING id
    `,
    [PENDING_ORDER_TIMEOUT_MINUTES],
  );

  return result.rowCount || 0;
}

const PendingPhonePeOrderScheduler = new CronJob(
  PENDING_ORDER_CRON_EXPRESSION,
  async () => {
    try {
      const expiredCount = await expireStalePendingPhonePeOrders();
      if (expiredCount > 0) {
       
      }
    } catch (error) {
      console.error("[PhonePe Pending Scheduler] Failed to expire pending orders", error);
    }
  },
  null,
  false,
  CRON_TIMEZONE,
);

PendingPhonePeOrderScheduler.start();

module.exports = PendingPhonePeOrderScheduler;
