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
  listProductsForMerchant,
  updateProduct,
  getRecentOrdersForMerchant,
  listOrdersForMerchant,
  countOrdersForMerchant,
  getOrderDetail,
  updateOrderStatus,
  getMerchantMetrics,
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
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/).optional(),
  message: z.string().min(10).optional(),
});

merchantRouter.post('/onboarding/wallet', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = walletSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  // If a signature is provided, verify ownership of the address. Optional
  // for now — set WALLET_SIGNATURE_REQUIRED=true in env to enforce later.
  const sigProvided = parsed.data.signature && parsed.data.message;
  if (sigProvided) {
    try {
      const recovered = ethers.verifyMessage(parsed.data.message!, parsed.data.signature!);
      if (recovered.toLowerCase() !== parsed.data.address.toLowerCase()) {
        res.status(400).json({ error: 'signature does not match address' });
        return;
      }
      if (!parsed.data.message!.includes(req.merchantId!)) {
        res.status(400).json({ error: 'message must include your merchant id' });
        return;
      }
    } catch (err) {
      logger.error({ err }, 'wallet verification failed');
      res.status(400).json({ error: 'could not verify signature' });
      return;
    }
  }

  await updateMerchantWallet(req.merchantId!, ethers.getAddress(parsed.data.address));
  res.json({ ok: true, verified: Boolean(sigProvided) });
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
  store_name: z.string().min(1).max(120).optional(),
  currency_code: z.string().length(3).optional(),
  admin_telegram_id: z.number().int().positive().nullable().optional(),
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
  if (parsed.data.store_name !== undefined) {
    fields.push(`store_name = $${i++}`);
    values.push(parsed.data.store_name.trim());
  }
  if (parsed.data.currency_code) {
    fields.push(`currency_code = $${i++}`);
    values.push(parsed.data.currency_code.toUpperCase());
  }
  if (parsed.data.admin_telegram_id !== undefined) {
    fields.push(`admin_telegram_id = $${i++}`);
    values.push(parsed.data.admin_telegram_id);
  }
  if (fields.length === 0) {
    res.status(400).json({ error: 'no fields to update' });
    return;
  }
  fields.push(`updated_at = NOW()`);
  const { pool } = await import('../db/pool.js');
  await pool.query(
    `UPDATE merchants SET ${fields.join(', ')} WHERE id = $1`,
    values
  );
  const updated = await getMerchantById(req.merchantId!);
  res.json(updated ? publicMerchant(updated) : { ok: true });
});

// Update payout wallet from Settings (post-onboarding). Reuses signature-verify
// logic but does NOT reset onboarding_step.
merchantRouter.patch('/wallet', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = walletSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const sigProvided = parsed.data.signature && parsed.data.message;
  let verified = false;
  if (sigProvided) {
    try {
      const recovered = ethers.verifyMessage(parsed.data.message!, parsed.data.signature!);
      if (recovered.toLowerCase() !== parsed.data.address.toLowerCase()) {
        res.status(400).json({ error: 'signature does not match address' });
        return;
      }
      if (!parsed.data.message!.includes(req.merchantId!)) {
        res.status(400).json({ error: 'message must include your merchant id' });
        return;
      }
      verified = true;
    } catch (err) {
      logger.error({ err }, 'wallet verification failed');
      res.status(400).json({ error: 'could not verify signature' });
      return;
    }
  }
  const address = ethers.getAddress(parsed.data.address);
  const { pool } = await import('../db/pool.js');
  await pool.query(
    `UPDATE merchants
        SET payout_wallet = $2,
            wallet_verified_at = ${verified ? 'NOW()' : 'NULL'},
            updated_at = NOW()
      WHERE id = $1`,
    [req.merchantId, address]
  );
  const updated = await getMerchantById(req.merchantId!);
  res.json(updated ? publicMerchant(updated) : { ok: true, verified });
});

// Reconnect a new bot from Settings. Similar to onboarding/bot but keeps the
// merchant active if they were already live.
merchantRouter.patch('/bot', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = botSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  // Validate token against Telegram's API, same as onboarding path
  try {
    const r = await fetch(`https://api.telegram.org/bot${parsed.data.bot_token}/getMe`);
    const json = (await r.json()) as any;
    if (!json.ok) {
      res.status(400).json({ error: 'invalid bot token (Telegram rejected it)' });
      return;
    }
    const botInfo = json.result;
    const previous = await getMerchantById(req.merchantId!);
    // If it's the same bot, return early — avoids needless webhook re-registration
    if (previous && previous.bot_id === botInfo.id) {
      res.json(publicMerchant(previous));
      return;
    }
    // Invalidate the cached grammy Bot instance for the previous token (if any)
    if (previous?.bot_token) {
      invalidateBot(previous.bot_token);
    }
    const { pool } = await import('../db/pool.js');
    await pool.query(
      `UPDATE merchants
          SET bot_token = $2, bot_id = $3, bot_username = $4, updated_at = NOW()
        WHERE id = $1`,
      [req.merchantId, parsed.data.bot_token, botInfo.id, botInfo.username]
    );
    // Register webhook for the new bot
    try {
      await fetch(
        `https://api.telegram.org/bot${parsed.data.bot_token}/setWebhook?url=${encodeURIComponent(
          `${env.PUBLIC_URL}/telegram/${env.TELEGRAM_WEBHOOK_SECRET}`
        )}`
      );
    } catch (err) {
      logger.warn({ err }, 'webhook registration failed on bot change');
    }
    const updated = await getMerchantById(req.merchantId!);
    res.json(updated ? publicMerchant(updated) : { ok: true });
  } catch (err) {
    logger.error({ err }, 'bot update failed');
    res.status(400).json({ error: 'could not validate bot token' });
  }
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

const productPatchSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  price: z.number().positive().optional(),
  stock: z.number().int().min(0).optional(),
  image_url: z.string().url().nullable().optional(),
  status: z.enum(['active', 'inactive', 'out_of_stock']).optional(),
  sku: z.string().max(64).nullable().optional(),
});

merchantRouter.get('/products', requireAuth, async (req: AuthedRequest, res) => {
  const asStr = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : undefined;
  const products = await listProductsForMerchant(req.merchantId!, {
    status: asStr(req.query.status),
    search: asStr(req.query.search),
  });
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

merchantRouter.patch('/products/:id', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = productPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const updated = await updateProduct(req.merchantId!, String(req.params.id), parsed.data);
  if (!updated) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(updated);
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

merchantRouter.get('/orders', requireAuth, async (req: AuthedRequest, res) => {
  const q = req.query;
  const asStr = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : undefined;

  const status = asStr(q.status);
  const search = asStr(q.search);
  const sinceStr = asStr(q.since);
  const untilStr = asStr(q.until);
  const since = sinceStr ? new Date(sinceStr) : undefined;
  const until = untilStr ? new Date(untilStr) : undefined;
  const limit = asStr(q.limit) ? Number(asStr(q.limit)) : 50;
  const offset = asStr(q.offset) ? Number(asStr(q.offset)) : 0;

  const [orders, total] = await Promise.all([
    listOrdersForMerchant(req.merchantId!, { status, search, since, until, limit, offset }),
    countOrdersForMerchant(req.merchantId!, { status, search, since, until }),
  ]);
  res.json({ orders, total });
});

merchantRouter.get('/orders/export.csv', requireAuth, async (req: AuthedRequest, res) => {
  const asStr = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : undefined;
  const status = asStr(req.query.status);
  const sinceStr = asStr(req.query.since);
  const untilStr = asStr(req.query.until);
  const since = sinceStr ? new Date(sinceStr) : undefined;
  const until = untilStr ? new Date(untilStr) : undefined;

  const orders = await listOrdersForMerchant(req.merchantId!, {
    status, since, until, limit: 10_000,
  });

  const header = [
    'order_number', 'created_at', 'status', 'buyer', 'currency',
    'subtotal', 'shipping', 'total', 'paid_at', 'shipped_at',
    'tracking_carrier', 'tracking_number',
  ];
  const escape = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const o of orders) {
    const buyer = o.buyer_telegram_username
      ? `@${o.buyer_telegram_username}`
      : o.buyer_telegram_first_name ?? '';
    lines.push(
      [
        o.order_number, o.created_at, o.status, buyer, o.currency_code,
        o.subtotal, o.shipping, o.total, o.paid_at ?? '', o.shipped_at ?? '',
        o.tracking_carrier ?? '', o.tracking_number ?? '',
      ].map(escape).join(',')
    );
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders.csv"`);
  res.send(lines.join('\n'));
});

merchantRouter.get('/orders/:id', requireAuth, async (req: AuthedRequest, res) => {
  const id = String(req.params.id);
  const order = await getOrderDetail(req.merchantId!, id);
  if (!order) {
    res.status(404).json({ error: 'order not found' });
    return;
  }
  res.json(order);
});

const orderUpdateSchema = z.object({
  status: z.enum([
    'awaiting_payment', 'paid', 'processing',
    'shipped', 'delivered', 'cancelled', 'refunded',
  ]).optional(),
  tracking_number: z.string().max(100).optional(),
  tracking_carrier: z.string().max(50).optional(),
  tracking_url: z.string().url().max(500).optional().or(z.literal('')),
  merchant_notes: z.string().max(2000).optional(),
  refund_amount: z.number().nonnegative().optional(),
});

merchantRouter.patch('/orders/:id', requireAuth, async (req: AuthedRequest, res) => {
  const id = String(req.params.id);
  const parsed = orderUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const existing = await getOrderDetail(req.merchantId!, id);
  if (!existing) {
    res.status(404).json({ error: 'order not found' });
    return;
  }
  await updateOrderStatus(
    req.merchantId!,
    id,
    parsed.data.status ?? existing.status,
    {
      tracking_number: parsed.data.tracking_number,
      tracking_carrier: parsed.data.tracking_carrier,
      tracking_url: parsed.data.tracking_url === '' ? undefined : parsed.data.tracking_url,
      merchant_notes: parsed.data.merchant_notes,
      refund_amount: parsed.data.refund_amount,
    }
  );
  const updated = await getOrderDetail(req.merchantId!, id);
  res.json(updated);
});

merchantRouter.get('/metrics', requireAuth, async (req: AuthedRequest, res) => {
  const metrics = await getMerchantMetrics(req.merchantId!);
  res.json(metrics);
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
  bot_id: number | null;
  admin_telegram_id: number | null;
  payout_wallet: string | null;
  wallet_verified_at: Date | null;
  currency_code: string;
  status: string;
  onboarding_step: string;
}) {
  return {
    id: m.id,
    email: m.email,
    store_name: m.store_name,
    store_slug: m.store_slug,
    bot_username: m.bot_username,
    bot_id: m.bot_id,
    admin_telegram_id: m.admin_telegram_id,
    payout_wallet: m.payout_wallet,
    wallet_verified: Boolean(m.wallet_verified_at),
    currency_code: m.currency_code,
    status: m.status,
    onboarding_step: m.onboarding_step,
  };
}
