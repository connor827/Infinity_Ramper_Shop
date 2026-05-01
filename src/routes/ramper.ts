import { Router, type Request, type Response } from 'express';
import {
  getOrderById,
  markOrderPaid,
  recordRamperCallback,
} from '../db/shop.js';
import { notifyBuyerOfPayment, notifyMerchantOfPayment } from '../bot/notifications.js';
import { logger } from '../config/logger.js';

export const ramperRouter = Router();

/**
 * Ramper GETs this when a buyer completes payment. The merchant's share has
 * already been sent on-chain to their payout wallet, and (if affiliate is
 * enabled) the platform's share to the affiliate wallet — Ramper handles
 * the split.
 *
 * Parameters appended by Ramper:
 *   - value_coin: USDC amount received
 *   - coin:       e.g. "polygon_usdc"
 *   - txid_in:    tx from payment provider to Ramper's temp address
 *   - txid_out:   tx from temp address to merchant's payout wallet
 * Plus our original callback parameters (order_id).
 */
ramperRouter.get('/webhook/ramper', async (req: Request, res: Response) => {
  const rawQuery = req.query as Record<string, string>;
  const orderId = typeof rawQuery.order_id === 'string' ? rawQuery.order_id : null;
  const txidIn = typeof rawQuery.txid_in === 'string' ? rawQuery.txid_in : null;
  const txidOut = typeof rawQuery.txid_out === 'string' ? rawQuery.txid_out : null;
  const valueCoinStr = typeof rawQuery.value_coin === 'string' ? rawQuery.value_coin : null;
  const coin = typeof rawQuery.coin === 'string' ? rawQuery.coin : null;

  logger.info({ orderId, txidIn, valueCoinStr }, 'Ramper callback received');

  if (!orderId || !txidIn) {
    res.status(400).send('missing params');
    return;
  }

  const valueCoin = valueCoinStr ? Number(valueCoinStr) : null;

  // Always record the callback for audit trail.
  await recordRamperCallback(
    orderId,
    { value_coin: valueCoin, coin, txid_in: txidIn, txid_out: txidOut ?? '' },
    rawQuery
  );

  const order = await getOrderById(orderId);
  if (!order) {
    logger.warn({ orderId }, 'Ramper callback for unknown order');
    res.status(404).send('order not found');
    return;
  }

  if (order.status !== 'awaiting_payment') {
    // Already processed — return 200 so Ramper doesn't retry.
    res.status(200).send('already processed');
    return;
  }

  const ok = await markOrderPaid(order.id, {
    value_coin: valueCoin ?? 0,
    txid_in: txidIn,
    txid_out: txidOut ?? '',
  });

  if (!ok) {
    res.status(200).send('already processed');
    return;
  }

  notifyBuyerOfPayment(order.id).catch((e) =>
    logger.error({ e, orderId: order.id }, 'notifyBuyer failed')
  );
  notifyMerchantOfPayment(order.id).catch((e) =>
    logger.error({ e, orderId: order.id }, 'notifyMerchant failed')
  );

  res.status(200).send('ok');
});
