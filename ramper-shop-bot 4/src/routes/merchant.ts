import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { ethers } from 'ethers';
import {
  createMerchant,
  getMerchantByEmail,
  getMerchantById,
  updateMerchantBot,
  updateMerchantWallet,
  activateMerchant,
} from '../db/merchants.js';
import {
  createProduct,
  listActiveProducts,
  getRecentOrdersForMerchant,
} from '../db/shop.js';
import { hashPassword, verifyPassword, signToken, verifyToken } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { invalidateBot } from '../bot/factory.js';

export const merchantRouter = Router();

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

interface AuthedRequest extends Request {
  merchantId?: string;
}

async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing token' });
    return;
  }
  const payload = verifyToken(header.slice(7));
  if (!payload) {
    res.status(401).json({ error: 'invalid token' });
    return;
  }
  req.merchantId = payload.sub;
  next();
}

// ---------------------------------------------------------------------------
// Signup + login
// ---------------------------------------------------------------------------

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  store_name: z.string().min(2).max(80),
});

merchantRouter.post('/auth/signup', async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { email, password, store_name } = parsed.data;

  const existing = await getMerchantByEmail(email);
  if (existing) {
    res.status(409).json({ error: 'email already registered' });
    return;
  }

  const slug = slugify(store_name) + '-' + Math.random().toString(36).slice(2, 7);
  const hash = await hashPassword(password);
  const merchant = await createMerchant({
    email,
    password_hash: hash,
    store_name,
    store_slug: slug,
  });

  res.status(201).json({
    token: signToken(merchant.id),
    merchant: publicMerchant(merchant),
  });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

merchantRouter.post('/auth/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const merchant = await getMerchantByEmail(parsed.data.email);
  if (!merchant) {
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }

  // We need the password_hash for comparison — fetch with a raw query.
  const { pool } = await import('../db/pool.js');
  const hashRow = await pool.query<{ password_hash: string }>(
    'SELECT password_hash FROM merchants WHERE id = $1',
    [merchant.id]
  );
  const ok = await verifyPassword(parsed.data.password, hashRow.rows[0].password_hash);
  if (!ok) {
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }

  res.json({ token: signToken(merchant.id), merchant: publicMerchant(merchant) });
});

// ---------------------------------------------------------------------------
// Me / onboarding status
// ---------------------------------------------------------------------------

merchantRouter.get('/me', requireAuth, async (req: AuthedRequest, res) => {
  const merchant = await getMerchantById(req.merchantId!);
  if (!merchant) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(publicMerchant(merchant));
});

// ---------------------------------------------------------------------------
// Onboarding step 2: register bot token
// ---------------------------------------------------------------------------

const botSchema = z.object({
  bot_token: z.string().regex(/^\d+:[\w-]{30,}$/, 'looks like a Telegram bot token'),
});

merchantRouter.post('/onboarding/bot', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = botSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  // Validate the token by calling getMe on Telegram's API
  try {
    const r = await fetch(`https://api.telegram.org/bot${parsed.data.bot_token}/getMe`);
    const body = (await r.json()) as {
      ok: boolean;
      result?: { id: number; username: string };
    };
    if (!body.ok || !body.result) {
      res.status(400).json({ error: 'Telegram rejected this token' });
      return;
    }

    await updateMerchantBot(req.merchantId!, {
      bot_token: parsed.data.bot_token,
      bot_username: body.result.username,
      bot_id: body.result.id,
    });

    // Register the webhook with Telegram so updates start flowing.
    const webhookUrl = `${env.PUBLIC_URL}/webhook/telegram/${parsed.data.bot_token}`;
    const setRes = await fetch(
      `https://api.telegram.org/bot${parsed.data.bot_token}/setWebhook`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          drop_pending_updates: true,
        }),
      }
    );
    const setBody = (await setRes.json()) as { ok: boolean; description?: string };
    if (!setBody.ok) {
      logger.error({ setBody }, 'setWebhook failed');
      res.status(502).json({ error: 'failed to register webhook with Telegram' });
      return;
    }

    res.json({ ok: true, username: body.result.username });
  } catch (err) {
    logger.error({ err }, 'bot registration failed');
    res.status(500).json({ error: 'internal error' });
  }
});

// ---------------------------------------------------------------------------
// Onboarding step 3: connect wallet
// ---------------------------------------------------------------------------

const walletSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
  message: z.string().min(10),
});

merchantRouter.post('/onboarding/wallet', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = walletSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  // Verify the signature proves ownership of the address
  try {
    const recovered = ethers.verifyMessage(parsed.data.message, parsed.data.signature);
    if (recovered.toLowerCase() !== parsed.data.address.toLowerCase()) {
      res.status(400).json({ error: 'signature does not match address' });
      return;
    }
    // Sanity: the message should include the merchant id to prevent replay
    if (!parsed.data.message.includes(req.merchantId!)) {
      res.status(400).json({ error: 'message must include your merchant id' });
      return;
    }

    await updateMerchantWallet(req.merchantId!, ethers.getAddress(parsed.data.address));
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'wallet verification failed');
    res.status(400).json({ error: 'could not verify signature' });
  }
});

// ---------------------------------------------------------------------------
// Onboarding step 5: activate (go live)
// ---------------------------------------------------------------------------

merchantRouter.post('/onboarding/activate', requireAuth, async (req: AuthedRequest, res) => {
  const merchant = await getMerchantById(req.merchantId!);
  if (!merchant) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (!merchant.bot_token || !merchant.payout_wallet) {
    res.status(400).json({ error: 'onboarding incomplete' });
    return;
  }
  await activateMerchant(req.merchantId!);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Store settings
// ---------------------------------------------------------------------------

const storeSettingsSchema = z.object({
  currency_code: z.string().length(3).optional(),
  admin_telegram_id: z.number().int().positive().optional(),
});

merchantRouter.patch('/store', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = storeSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const fields: string[] = [];
  const values: any[] = [req.merchantId];
  let i = 2;
  if (parsed.data.currency_code) {
    fields.push(`currency_code = $${i++}`);
    values.push(parsed.data.currency_code.toUpperCase());
  }
  if (parsed.data.admin_telegram_id) {
    fields.push(`admin_telegram_id = $${i++}`);
    values.push(parsed.data.admin_telegram_id);
  }
  if (fields.length === 0) {
    res.status(400).json({ error: 'no fields to update' });
    return;
  }
  const { pool } = await import('../db/pool.js');
  await pool.query(
    `UPDATE merchants SET ${fields.join(', ')} WHERE id = $1`,
    values
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Product CRUD
// ---------------------------------------------------------------------------

const productSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  price: z.number().positive(),
  currency_code: z.string().length(3).optional(),
  stock: z.number().int().min(0),
  image_url: z.string().url().optional(),
});

merchantRouter.get('/products', requireAuth, async (req: AuthedRequest, res) => {
  const products = await listActiveProducts(req.merchantId!);
  res.json(products);
});

merchantRouter.post('/products', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const merchant = await getMerchantById(req.merchantId!);
  if (!merchant) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const product = await createProduct(req.merchantId!, {
    ...parsed.data,
    currency_code: parsed.data.currency_code ?? merchant.currency_code,
  });
  res.status(201).json(product);
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

merchantRouter.get('/orders', requireAuth, async (req: AuthedRequest, res) => {
  const orders = await getRecentOrdersForMerchant(req.merchantId!);
  res.json(orders);
});

// ---------------------------------------------------------------------------
// Suspend / rotate: invalidate cached bot on destructive ops
// ---------------------------------------------------------------------------

merchantRouter.post('/bot/disconnect', requireAuth, async (req: AuthedRequest, res) => {
  const merchant = await getMerchantById(req.merchantId!);
  if (!merchant?.bot_token) {
    res.status(400).json({ error: 'no bot connected' });
    return;
  }
  // Delete the webhook on Telegram's side
  await fetch(`https://api.telegram.org/bot${merchant.bot_token}/deleteWebhook`);
  invalidateBot(merchant.bot_token);
  const { pool } = await import('../db/pool.js');
  await pool.query(
    `UPDATE merchants SET bot_token = NULL, bot_id = NULL,
                          bot_username = NULL, onboarding_step = 'bot'
     WHERE id = $1`,
    [req.merchantId]
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function publicMerchant(m: {
  id: string;
  email: string | null;
  store_name: string;
  store_slug: string;
  bot_username: string | null;
  payout_wallet: string | null;
  status: string;
  onboarding_step: string;
}) {
  return {
    id: m.id,
    email: m.email,
    store_name: m.store_name,
    store_slug: m.store_slug,
    bot_username: m.bot_username,
    payout_wallet: m.payout_wallet,
    status: m.status,
    onboarding_step: m.onboarding_step,
  };
}
