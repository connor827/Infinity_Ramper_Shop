import { Router, type Request, type Response } from 'express';
import { webhookCallback } from 'grammy';
import { getMerchantByBotToken } from '../db/merchants.js';
import { getBotForMerchant } from '../bot/factory.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export const telegramRouter = Router();

// Cache merchant lookups briefly so every webhook doesn't hit the DB.
// Tokens are stable per merchant; cache for 5 minutes.
const merchantCache = new Map<string, { merchantId: string; expiresAt: number }>();
const MERCHANT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * The Telegram webhook URL is registered as:
 *   https://your-domain.com/webhook/telegram/<bot_token>
 */
telegramRouter.post('/webhook/telegram/:botToken', async (req: Request, res: Response) => {
  const botTokenRaw = req.params.botToken;
  const botToken = Array.isArray(botTokenRaw) ? botTokenRaw[0] : botTokenRaw;
  if (!botToken) {
    res.sendStatus(400);
    return;
  }

  const rawSecret = req.get('x-telegram-bot-api-secret-token');
  const secret = Array.isArray(rawSecret) ? rawSecret[0] : rawSecret;
  if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    logger.warn({ botToken: botToken.slice(0, 8) + '…' }, 'webhook secret mismatch');
    res.sendStatus(401);
    return;
  }

  const merchant = await getMerchantByBotToken(botToken);
  if (!merchant) {
    logger.warn({ botToken: botToken.slice(0, 8) + '…' }, 'no merchant for token');
    res.sendStatus(404);
    return;
  }

  const bot = getBotForMerchant(merchant);
  const handler = webhookCallback(bot, 'express', {
    timeoutMilliseconds: 10_000,
    onTimeout: 'return',
  });
  try {
    return await handler(req, res);
  } catch (err) {
    // Never let errors in bot handlers bubble up — we already replied 200 to
    // Telegram (or we will), and crashing the Node process for a stale
    // callback query would trigger a reboot cascade.
    logger.error({ err, merchantId: merchant.id }, 'webhook handler error');
    if (!res.headersSent) res.sendStatus(200);
    return;
  }
});
