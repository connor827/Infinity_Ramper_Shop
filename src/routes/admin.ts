import { Router, type Request, type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { verifyPassword } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getMerchantById } from '../db/merchants.js';
import { invalidateBot } from '../bot/factory.js';
import { query } from '../db/pool.js';
import {
  getPlatformMetrics,
  listMerchantsForAdmin,
  getMerchantDetailForAdmin,
  getActivityFeed,
  logAdminAction,
} from '../db/admin.js';

export const adminRouter = Router();

interface AdminRequest extends Request {
  adminEmail?: string;
}

// ---------------------------------------------------------------------------
// Admin auth — separate from merchant auth
// ---------------------------------------------------------------------------

// Bcrypt hash for the admin password, set in env. If unset, the entire admin
// subsystem is disabled — login endpoint returns 503.
function isAdminEnabled(): boolean {
  return Boolean(env.ADMIN_EMAIL && env.ADMIN_PASSWORD_HASH);
}

async function requireAdmin(
  req: AdminRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!isAdminEnabled()) {
    res.status(503).json({ error: 'Admin is not configured on this server.' });
    return;
  }
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing token' });
    return;
  }
  try {
    const token = header.slice(7);
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (typeof decoded !== 'object' || !decoded || !('sub' in decoded) || !('role' in decoded)) {
      res.status(403).json({ error: 'invalid admin token' });
      return;
    }
    const payload = decoded as { sub: string; role: string };
    if (payload.role !== 'admin') {
      res.status(403).json({ error: 'not an admin token' });
      return;
    }
    // Defensive: only accept tokens signed for the current admin email.
    // If ADMIN_EMAIL changes, old tokens stop working immediately.
    if (payload.sub !== env.ADMIN_EMAIL) {
      res.status(403).json({ error: 'admin email mismatch' });
      return;
    }
    req.adminEmail = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

adminRouter.post('/auth/login', async (req, res) => {
  if (!isAdminEnabled()) {
    res.status(503).json({ error: 'Admin is not configured on this server.' });
    return;
  }
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid request' });
    return;
  }
  const { email, password } = parsed.data;

  // Constant-ish-time: always run bcrypt compare, never short-circuit on email mismatch,
  // to avoid timing leaks of whether the email matches.
  const passwordOk = await verifyPassword(password, env.ADMIN_PASSWORD_HASH!);
  const emailOk = email.toLowerCase() === env.ADMIN_EMAIL!.toLowerCase();

  if (!passwordOk || !emailOk) {
    logger.warn({ email, ip: req.ip }, 'admin login failed');
    // Deliberately vague so attackers can't enumerate admin email
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }

  const token = jwt.sign(
    { sub: env.ADMIN_EMAIL!, role: 'admin' },
    env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  await logAdminAction({
    admin_email: env.ADMIN_EMAIL!,
    action: 'login',
    ip_address: req.ip ?? null,
  });
  logger.info({ email, ip: req.ip }, 'admin logged in');
  res.json({ token });
});

// ---------------------------------------------------------------------------
// Who am I (cheap auth check for the dashboard to verify token validity)
// ---------------------------------------------------------------------------

adminRouter.get('/me', requireAdmin, async (req: AdminRequest, res) => {
  res.json({ email: req.adminEmail });
});

// ---------------------------------------------------------------------------
// Platform metrics
// ---------------------------------------------------------------------------

adminRouter.get('/metrics', requireAdmin, async (_req, res) => {
  const metrics = await getPlatformMetrics();
  res.json(metrics);
});

// ---------------------------------------------------------------------------
// Merchant list
// ---------------------------------------------------------------------------

adminRouter.get('/merchants', requireAdmin, async (req, res) => {
  const asStr = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : undefined;
  const asInt = (v: unknown): number | undefined => {
    if (typeof v !== 'string') return undefined;
    const n = parseInt(v, 10);
    return isFinite(n) ? n : undefined;
  };
  const result = await listMerchantsForAdmin({
    status: asStr(req.query.status),
    search: asStr(req.query.search),
    limit: asInt(req.query.limit),
    offset: asInt(req.query.offset),
  });
  res.json(result);
});

// ---------------------------------------------------------------------------
// Merchant detail
// ---------------------------------------------------------------------------

adminRouter.get('/merchants/:id', requireAdmin, async (req, res) => {
  const detail = await getMerchantDetailForAdmin(String(req.params.id));
  if (!detail) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(detail);
});

// ---------------------------------------------------------------------------
// Suspend / activate
// ---------------------------------------------------------------------------

adminRouter.post(
  '/merchants/:id/suspend',
  requireAdmin,
  async (req: AdminRequest, res) => {
    const id = String(req.params.id);
    const merchant = await getMerchantById(id);
    if (!merchant) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (merchant.status === 'suspended') {
      res.json({ ok: true, status: 'suspended', note: 'already suspended' });
      return;
    }
    await query(
      `UPDATE merchants SET status = 'suspended', updated_at = NOW() WHERE id = $1`,
      [id]
    );
    // Evict cached bot instance so the webhook returns 404 on next request
    if (merchant.bot_token) invalidateBot(merchant.bot_token);
    await logAdminAction({
      admin_email: req.adminEmail!,
      action: 'suspend_merchant',
      target_merchant_id: id,
      metadata: { reason: typeof req.body?.reason === 'string' ? req.body.reason : null },
      ip_address: req.ip ?? null,
    });
    logger.warn({ merchantId: id, by: req.adminEmail }, 'merchant suspended');
    res.json({ ok: true, status: 'suspended' });
  }
);

adminRouter.post(
  '/merchants/:id/activate',
  requireAdmin,
  async (req: AdminRequest, res) => {
    const id = String(req.params.id);
    const merchant = await getMerchantById(id);
    if (!merchant) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (merchant.status === 'active') {
      res.json({ ok: true, status: 'active', note: 'already active' });
      return;
    }
    // Only activate merchants who completed onboarding — prevent reactivating
    // half-set-up merchants that'd break in the webhook.
    if (!merchant.bot_token || !merchant.payout_wallet) {
      res.status(400).json({
        error: 'cannot activate — merchant is missing bot or wallet',
      });
      return;
    }
    await query(
      `UPDATE merchants SET status = 'active', updated_at = NOW() WHERE id = $1`,
      [id]
    );
    if (merchant.bot_token) invalidateBot(merchant.bot_token);
    await logAdminAction({
      admin_email: req.adminEmail!,
      action: 'activate_merchant',
      target_merchant_id: id,
      ip_address: req.ip ?? null,
    });
    logger.info({ merchantId: id, by: req.adminEmail }, 'merchant activated');
    res.json({ ok: true, status: 'active' });
  }
);

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

adminRouter.get('/activity', requireAdmin, async (_req, res) => {
  const activity = await getActivityFeed(40);
  res.json(activity);
});
