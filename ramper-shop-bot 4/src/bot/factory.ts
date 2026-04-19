import { Bot, Context, session, SessionFlavor } from 'grammy';
import type { Merchant } from '../types/index.js';
import { registerHandlers } from './handlers.js';
import { logger } from '../config/logger.js';

export interface SessionData {
  checkout?: {
    step: 'name' | 'email' | 'line_1' | 'city' | 'postal_code' | 'country' | 'phone' | 'confirm';
    data: Partial<{
      full_name: string;
      email: string;
      line_1: string;
      city: string;
      postal_code: string;
      country: string;
      phone: string;
    }>;
  };
}

export interface MerchantContextFlavor {
  merchant: Merchant;
  buyerId: string; // set by middleware on first message
}

export type BotContext = Context & SessionFlavor<SessionData> & MerchantContextFlavor;

/**
 * Cache of Bot instances keyed by bot token.
 *
 * grammy's `Bot` holds some API-client state so we reuse the same instance
 * for a given merchant rather than constructing a new one per webhook.
 */
const botCache = new Map<string, Bot<BotContext>>();

export function getBotForMerchant(merchant: Merchant): Bot<BotContext> {
  if (!merchant.bot_token) {
    throw new Error(`Merchant ${merchant.id} has no bot token configured`);
  }
  const cached = botCache.get(merchant.bot_token);
  if (cached) return cached;

  const bot = new Bot<BotContext>(merchant.bot_token);

  // In-memory session. Swap for a redis-backed adapter in production.
  bot.use(session({ initial: (): SessionData => ({}) }));

  // Inject merchant context on every update.
  bot.use(async (ctx, next) => {
    ctx.merchant = merchant;
    await next();
  });

  registerHandlers(bot);

  bot.catch((err) => {
    logger.error(
      { err, merchantId: merchant.id, update: err.ctx.update },
      'bot handler error'
    );
  });

  botCache.set(merchant.bot_token, bot);
  return bot;
}

/**
 * Invalidate a cached bot — call when a merchant's token rotates or the
 * merchant is suspended.
 */
export function invalidateBot(botToken: string): void {
  botCache.delete(botToken);
}
