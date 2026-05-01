import { query } from '../db/pool.js';
import { getMerchantById } from '../db/merchants.js';
import { getBotForMerchant } from './factory.js';
import { logger } from '../config/logger.js';

interface OrderJoined {
  order_id: string;
  merchant_id: string;
  order_number: number;
  total: string;
  currency_code: string;
  telegram_id: number;
}

export async function notifyBuyerOfPayment(orderId: string): Promise<void> {
  const { rows } = await query<OrderJoined>(
    `SELECT o.id AS order_id, o.merchant_id, o.order_number, o.total, o.currency_code,
            b.telegram_id
       FROM orders o
       JOIN buyers b ON o.buyer_id = b.id
      WHERE o.id = $1`,
    [orderId]
  );
  const row = rows[0];
  if (!row) return;

  const merchant = await getMerchantById(row.merchant_id);
  if (!merchant) return;
  const bot = getBotForMerchant(merchant);

  try {
    const customMessage = merchant.order_received_message?.trim();
    // The first line confirms it's gone through, with the merchant's name
    // for trust (so buyers seeing this in a Telegram notification stack
    // know which shop the message is from). Then the order number and
    // amount as a quick receipt-style summary, then either the merchant's
    // custom thank-you note or our default closing.
    const base =
      `Payment received - thanks for your order!\n\n` +
      `${merchant.store_name}\n` +
      `Order #${row.order_number}\n` +
      `Amount: ${row.currency_code} ${Number(row.total).toFixed(2)}\n\n`;
    const closing = customMessage && customMessage.length > 0
      ? customMessage
      : `Your order is now being processed. You'll get another message ` +
        `here when it ships, with tracking details if available.`;
    await bot.api.sendMessage(row.telegram_id, base + closing);
  } catch (err) {
    logger.error({ err, orderId }, 'failed to notify buyer');
  }
}

export async function notifyMerchantOfPayment(orderId: string): Promise<void> {
  const { rows } = await query<{
    order_number: number;
    total: string;
    currency_code: string;
    merchant_id: string;
  }>(
    `SELECT order_number, total, currency_code, merchant_id
       FROM orders WHERE id = $1`,
    [orderId]
  );
  const row = rows[0];
  if (!row) return;

  const merchant = await getMerchantById(row.merchant_id);
  if (!merchant || !merchant.admin_telegram_id) {
    logger.debug({ merchantId: row.merchant_id }, 'no admin_telegram_id, skipping merchant notify');
    return;
  }

  const bot = getBotForMerchant(merchant);
  try {
    await bot.api.sendMessage(
      merchant.admin_telegram_id,
      `New paid order: #${row.order_number}\n` +
        `Amount: ${row.currency_code} ${Number(row.total).toFixed(2)}\n\n` +
        `USDC has been deposited to your payout wallet.`
    );
  } catch (err) {
    logger.error({ err, orderId }, 'failed to notify merchant');
  }
}
