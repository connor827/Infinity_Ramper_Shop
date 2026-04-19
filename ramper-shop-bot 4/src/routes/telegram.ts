import { Router, type Request, type Response } from 'express';
import { webhookCallback } from 'grammy';
import { getMerchantByBotToken } from '../db/merchants.js';
import { getBotForMerchant } from '../bot/factory.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export const telegramRouter = Router();

/**
 * The Telegram webhook URL is registered as:
 *   https://your-domain.com/webhook/telegram/<bot_token>
 *
 * We extract the bot token from the URL, look up the corresponding merchant,
 * and dispatch the update to that merchant's Bot instance.
 *
 * Security:
 *  - The bot token itself is a shared secret; only Telegram and we know it.
 *  - We also require an X-Telegram-Bot-Api-Secret-Token header matching
 *    env.TELEGRAM_WEBHOOK_SECRET, which Telegram echoes if configured.
 */
telegramRouter.post('/webhook/telegram/:botToken', async (req: Request, res: Response) => {
  const botTokenRaw = req.params.botToken;
  const botToken = Array.isArray(botTokenRaw) ? botTokenRaw[0] : botTokenRaw;
  if (!botToken) {
    res.sendStatus(400);
    return;
  }

  // Verify the optional secret header. When registering the webhook with
  // Telegram, pass secret_token = env.TELEGRAM_WEBHOOK_SECRET.
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
  const handler = webhookCallback(bot, 'express');
  return handler(req, res);
});
