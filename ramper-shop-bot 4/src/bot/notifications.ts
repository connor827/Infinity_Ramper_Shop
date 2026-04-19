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
    await bot.api.sendMessage(
      row.telegram_id,
      `Payment received for order #${row.order_number}\n\n` +
        `Amount: ${row.currency_code} ${Number(row.total).toFixed(2)}\n\n` +
        `You'll get a shipping notification when your order is on its way.`
    );
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
