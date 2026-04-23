import { query } from './pool.js';

// ------------------------------------------------------------------
// Platform-wide metrics
// ------------------------------------------------------------------

export interface PlatformMetrics {
  total_merchants: number;
  active_merchants: number;
  suspended_merchants: number;
  merchants_without_bot: number;
  merchants_without_wallet: number;
  merchants_with_zero_products: number;
  merchants_inactive_14d: number;  // active, has products, zero orders in 14d
  total_orders_all_time: number;
  total_orders_30d: number;
  platform_revenue_30d: string;
  platform_revenue_all_time: string;
  // Daily series for charts
  signup_series: Array<{ date: string; count: number }>;
  revenue_series: Array<{ date: string; revenue: string; orders: number }>;
}

export async function getPlatformMetrics(): Promise<PlatformMetrics> {
  // One round-trip with many CTEs would be clever but brittle. Several small
  // queries are easier to reason about and plenty fast at current scale.

  const merchantCounts = await query<{
    total: string;
    active: string;
    suspended: string;
    no_bot: string;
    no_wallet: string;
  }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(CASE WHEN status = 'active' THEN 1 END)::text AS active,
       COUNT(CASE WHEN status = 'suspended' THEN 1 END)::text AS suspended,
       COUNT(CASE WHEN bot_token IS NULL THEN 1 END)::text AS no_bot,
       COUNT(CASE WHEN payout_wallet IS NULL THEN 1 END)::text AS no_wallet
     FROM merchants`
  );

  // Merchants who are active and have products but haven't taken an order in 14 days
  const inactive = await query<{ count: string }>(
    `SELECT COUNT(DISTINCT m.id)::text AS count
       FROM merchants m
       WHERE m.status = 'active'
         AND EXISTS (SELECT 1 FROM products p WHERE p.merchant_id = m.id AND p.status = 'active')
         AND NOT EXISTS (
           SELECT 1 FROM orders o
            WHERE o.merchant_id = m.id
              AND o.paid_at > NOW() - interval '14 days'
         )`
  );

  const zeroProducts = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM merchants m
      WHERE m.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM products p WHERE p.merchant_id = m.id)`
  );

  const orderStats = await query<{
    total_orders: string;
    orders_30d: string;
    revenue_30d: string;
    revenue_all: string;
  }>(
    `SELECT
       COUNT(*)::text AS total_orders,
       COUNT(CASE WHEN paid_at > NOW() - interval '30 days' THEN 1 END)::text AS orders_30d,
       COALESCE(SUM(CASE WHEN paid_at > NOW() - interval '30 days' THEN total END), 0)::text AS revenue_30d,
       COALESCE(SUM(CASE WHEN status IN ('paid','processing','shipped','delivered') THEN total END), 0)::text AS revenue_all
     FROM orders`
  );

  // 30 daily buckets — signups
  const signupSeries = await query<{ date: string; count: string }>(
    `WITH days AS (
       SELECT generate_series(
         (NOW() - interval '29 days')::date,
         NOW()::date,
         '1 day'
       )::date AS d
     )
     SELECT to_char(days.d, 'YYYY-MM-DD') AS date,
            COUNT(m.id)::text AS count
       FROM days
       LEFT JOIN merchants m ON m.created_at::date = days.d
      GROUP BY days.d
      ORDER BY days.d`
  );

  // 30 daily buckets — platform revenue
  const revenueSeries = await query<{ date: string; revenue: string; orders: string }>(
    `WITH days AS (
       SELECT generate_series(
         (NOW() - interval '29 days')::date,
         NOW()::date,
         '1 day'
       )::date AS d
     )
     SELECT to_char(days.d, 'YYYY-MM-DD') AS date,
            COALESCE(SUM(o.total), 0)::text AS revenue,
            COUNT(o.id)::text AS orders
       FROM days
       LEFT JOIN orders o
         ON o.paid_at::date = days.d
      GROUP BY days.d
      ORDER BY days.d`
  );

  const mc = merchantCounts.rows[0]!;
  const os = orderStats.rows[0]!;

  return {
    total_merchants: Number(mc.total),
    active_merchants: Number(mc.active),
    suspended_merchants: Number(mc.suspended),
    merchants_without_bot: Number(mc.no_bot),
    merchants_without_wallet: Number(mc.no_wallet),
    merchants_with_zero_products: Number(zeroProducts.rows[0]?.count ?? 0),
    merchants_inactive_14d: Number(inactive.rows[0]?.count ?? 0),
    total_orders_all_time: Number(os.total_orders),
    total_orders_30d: Number(os.orders_30d),
    platform_revenue_30d: os.revenue_30d,
    platform_revenue_all_time: os.revenue_all,
    signup_series: signupSeries.rows.map(r => ({ date: r.date, count: Number(r.count) })),
    revenue_series: revenueSeries.rows.map(r => ({
      date: r.date,
      revenue: r.revenue,
      orders: Number(r.orders),
    })),
  };
}

// ------------------------------------------------------------------
// Merchant list (with enriched fields for admin view)
// ------------------------------------------------------------------

export interface AdminMerchantListItem {
  id: string;
  email: string | null;
  store_name: string;
  bot_username: string | null;
  status: string;
  onboarding_step: string;
  created_at: Date;
  has_bot: boolean;
  has_wallet: boolean;
  product_count: number;
  order_count: number;
  revenue_30d: string;
  last_order_at: Date | null;
}

export async function listMerchantsForAdmin(opts: {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ merchants: AdminMerchantListItem[]; total: number }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const values: unknown[] = [];
  const where: string[] = [];

  if (opts.status && ['active', 'pending', 'suspended', 'terminated'].includes(opts.status)) {
    values.push(opts.status);
    where.push(`m.status = $${values.length}`);
  }
  if (opts.search && opts.search.trim()) {
    values.push(`%${opts.search.trim()}%`);
    where.push(`(m.store_name ILIKE $${values.length} OR m.email ILIKE $${values.length} OR m.bot_username ILIKE $${values.length})`);
  }

  const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const countRes = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM merchants m ${whereSQL}`,
    values
  );

  values.push(limit, offset);
  const limitIdx = values.length - 1;
  const offsetIdx = values.length;

  const listRes = await query<AdminMerchantListItem & { has_bot: boolean; has_wallet: boolean }>(
    `SELECT
       m.id,
       m.email,
       m.store_name,
       m.bot_username,
       m.status,
       m.onboarding_step,
       m.created_at,
       (m.bot_token IS NOT NULL) AS has_bot,
       (m.payout_wallet IS NOT NULL) AS has_wallet,
       COALESCE(p.product_count, 0)::int AS product_count,
       COALESCE(o.order_count, 0)::int AS order_count,
       COALESCE(o.revenue_30d, 0)::text AS revenue_30d,
       o.last_order_at
     FROM merchants m
     LEFT JOIN (
       SELECT merchant_id, COUNT(*) AS product_count
         FROM products WHERE status != 'inactive'
        GROUP BY merchant_id
     ) p ON p.merchant_id = m.id
     LEFT JOIN (
       SELECT merchant_id,
              COUNT(*) AS order_count,
              SUM(CASE WHEN paid_at > NOW() - interval '30 days' THEN total ELSE 0 END) AS revenue_30d,
              MAX(paid_at) AS last_order_at
         FROM orders
        GROUP BY merchant_id
     ) o ON o.merchant_id = m.id
     ${whereSQL}
     ORDER BY m.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    values
  );

  return {
    merchants: listRes.rows,
    total: Number(countRes.rows[0]?.count ?? 0),
  };
}

// ------------------------------------------------------------------
// Merchant detail (for the drill-down view)
// ------------------------------------------------------------------

export interface AdminMerchantDetail {
  merchant: {
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
    welcome_message: string | null;
    description: string | null;
    created_at: Date;
    updated_at: Date;
  };
  stats: {
    product_count: number;
    order_count: number;
    revenue_all_time: string;
    revenue_30d: string;
    last_order_at: Date | null;
  };
  recent_orders: Array<{
    id: string;
    order_number: number;
    total: string;
    currency_code: string;
    status: string;
    created_at: Date;
  }>;
}

export async function getMerchantDetailForAdmin(id: string): Promise<AdminMerchantDetail | null> {
  const merchantRes = await query<AdminMerchantDetail['merchant']>(
    `SELECT
       id, email, store_name, store_slug, bot_username, bot_id,
       admin_telegram_id, payout_wallet, wallet_verified_at, currency_code,
       status, onboarding_step, welcome_message, description,
       created_at, updated_at
     FROM merchants WHERE id = $1`,
    [id]
  );
  if (merchantRes.rows.length === 0) return null;

  const statsRes = await query<{
    product_count: string;
    order_count: string;
    revenue_all: string;
    revenue_30d: string;
    last_order_at: Date | null;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM products WHERE merchant_id = $1 AND status != 'inactive')::text AS product_count,
       COUNT(*)::text AS order_count,
       COALESCE(SUM(CASE WHEN status IN ('paid','processing','shipped','delivered') THEN total ELSE 0 END), 0)::text AS revenue_all,
       COALESCE(SUM(CASE WHEN paid_at > NOW() - interval '30 days' THEN total ELSE 0 END), 0)::text AS revenue_30d,
       MAX(paid_at) AS last_order_at
     FROM orders WHERE merchant_id = $1`,
    [id]
  );

  const ordersRes = await query<AdminMerchantDetail['recent_orders'][number]>(
    `SELECT id, order_number, total, currency_code, status, created_at
       FROM orders WHERE merchant_id = $1
      ORDER BY created_at DESC LIMIT 10`,
    [id]
  );

  const s = statsRes.rows[0]!;
  return {
    merchant: merchantRes.rows[0]!,
    stats: {
      product_count: Number(s.product_count),
      order_count: Number(s.order_count),
      revenue_all_time: s.revenue_all,
      revenue_30d: s.revenue_30d,
      last_order_at: s.last_order_at,
    },
    recent_orders: ordersRes.rows,
  };
}

// ------------------------------------------------------------------
// Activity feed
// ------------------------------------------------------------------

export interface ActivityItem {
  kind: 'signup' | 'order' | 'bot_connected' | 'first_order';
  created_at: Date;
  merchant_id: string;
  merchant_name: string;
  detail: string;  // e.g. "$42.00 · #4829" or "@yourcoffee_bot"
}

export async function getActivityFeed(limit = 40): Promise<ActivityItem[]> {
  // Union of signups + orders, most recent first.
  const { rows } = await query<{
    kind: string;
    created_at: Date;
    merchant_id: string;
    merchant_name: string;
    detail: string;
  }>(
    `(
       SELECT 'signup' AS kind,
              m.created_at,
              m.id AS merchant_id,
              m.store_name AS merchant_name,
              COALESCE(m.email, '—') AS detail
         FROM merchants m
        ORDER BY m.created_at DESC
        LIMIT $1
     )
     UNION ALL
     (
       SELECT 'order' AS kind,
              o.created_at,
              m.id AS merchant_id,
              m.store_name AS merchant_name,
              '#' || o.order_number || ' · ' || o.currency_code || ' ' || o.total::text AS detail
         FROM orders o
         JOIN merchants m ON m.id = o.merchant_id
        ORDER BY o.created_at DESC
        LIMIT $1
     )
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows as ActivityItem[];
}

// ------------------------------------------------------------------
// Audit log (migration 005)
// ------------------------------------------------------------------

export async function logAdminAction(params: {
  admin_email: string;
  action: string;
  target_merchant_id?: string | null;
  metadata?: Record<string, unknown>;
  ip_address?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO admin_actions (admin_email, action, target_merchant_id, metadata, ip_address)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      params.admin_email,
      params.action,
      params.target_merchant_id ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
      params.ip_address ?? null,
    ]
  );
}
