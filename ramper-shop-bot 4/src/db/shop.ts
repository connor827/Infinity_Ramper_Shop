import pg from 'pg';
import { query, withTransaction } from './pool.js';
import type { Product, Buyer, Order, CartItem, ShippingAddress } from '../types/index.js';

// ------------------------------------------------------------------
// Products
// ------------------------------------------------------------------

export async function listActiveProducts(merchantId: string): Promise<Product[]> {
  const { rows } = await query<Product>(
    `SELECT * FROM products
      WHERE merchant_id = $1 AND status = 'active' AND stock > 0
      ORDER BY created_at DESC`,
    [merchantId]
  );
  return rows;
}

// List ALL products for the merchant dashboard — includes inactive, out-of-stock.
// Optional status filter: 'active' | 'inactive' | 'out_of_stock' | undefined (all).
export async function listProductsForMerchant(
  merchantId: string,
  opts: { status?: string; search?: string } = {}
): Promise<Product[]> {
  const values: unknown[] = [merchantId];
  const where: string[] = ['merchant_id = $1'];
  if (opts.status && ['active', 'inactive', 'out_of_stock'].includes(opts.status)) {
    values.push(opts.status);
    where.push(`status = $${values.length}`);
  }
  if (opts.search && opts.search.trim()) {
    values.push(`%${opts.search.trim()}%`);
    where.push(`name ILIKE $${values.length}`);
  }
  const { rows } = await query<Product>(
    `SELECT * FROM products
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC`,
    values
  );
  return rows;
}

// Apply a partial update to a product. Only columns in the allow-list are updatable.
export async function updateProduct(
  merchantId: string,
  productId: string,
  patch: Partial<{
    name: string;
    description: string | null;
    price: number;
    stock: number;
    image_url: string | null;
    status: 'active' | 'inactive' | 'out_of_stock';
    sku: string | null;
  }>
): Promise<Product | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    fields.push(`${key} = $${i++}`);
    values.push(value);
  }
  if (fields.length === 0) {
    return getProduct(merchantId, productId);
  }
  fields.push(`updated_at = NOW()`);
  values.push(productId, merchantId);
  const { rows } = await query<Product>(
    `UPDATE products
        SET ${fields.join(', ')}
      WHERE id = $${i++} AND merchant_id = $${i}
      RETURNING *`,
    values
  );
  return rows[0] ?? null;
}

export async function getProduct(
  merchantId: string,
  productId: string
): Promise<Product | null> {
  const { rows } = await query<Product>(
    'SELECT * FROM products WHERE id = $1 AND merchant_id = $2',
    [productId, merchantId]
  );
  return rows[0] ?? null;
}

export async function createProduct(
  merchantId: string,
  data: {
    name: string;
    description?: string;
    price: number;
    currency_code: string;
    stock: number;
    image_url?: string;
  }
): Promise<Product> {
  const { rows } = await query<Product>(
    `INSERT INTO products (merchant_id, name, description, price, currency_code, stock, image_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      merchantId,
      data.name,
      data.description ?? null,
      data.price,
      data.currency_code,
      data.stock,
      data.image_url ?? null,
    ]
  );
  return rows[0];
}

// ------------------------------------------------------------------
// Buyers
// ------------------------------------------------------------------

export async function upsertBuyer(
  merchantId: string,
  telegramId: number,
  username: string | null,
  firstName: string | null
): Promise<Buyer> {
  const { rows } = await query<Buyer>(
    `INSERT INTO buyers (merchant_id, telegram_id, username, first_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (merchant_id, telegram_id)
     DO UPDATE SET username = EXCLUDED.username,
                   first_name = EXCLUDED.first_name,
                   last_seen_at = NOW()
     RETURNING *`,
    [merchantId, telegramId, username, firstName]
  );
  return rows[0];
}

// ------------------------------------------------------------------
// Carts
// ------------------------------------------------------------------

async function getOrCreateCart(
  client: pg.PoolClient,
  merchantId: string,
  buyerId: string
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    'SELECT id FROM carts WHERE buyer_id = $1',
    [buyerId]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const created = await client.query<{ id: string }>(
    `INSERT INTO carts (merchant_id, buyer_id) VALUES ($1, $2) RETURNING id`,
    [merchantId, buyerId]
  );
  return created.rows[0].id;
}

export async function addToCart(
  merchantId: string,
  buyerId: string,
  productId: string,
  quantity: number
): Promise<void> {
  await withTransaction(async (client) => {
    const productRes = await client.query<{ price: string; stock: number }>(
      'SELECT price, stock FROM products WHERE id = $1 AND merchant_id = $2 FOR UPDATE',
      [productId, merchantId]
    );
    const product = productRes.rows[0];
    if (!product) throw new Error('Product not found');
    if (product.stock < quantity) throw new Error('Insufficient stock');

    const cartId = await getOrCreateCart(client, merchantId, buyerId);

    await client.query(
      `INSERT INTO cart_items (cart_id, product_id, quantity, unit_price)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (cart_id, product_id)
       DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity`,
      [cartId, productId, quantity, product.price]
    );
  });
}

export async function getCart(buyerId: string): Promise<CartItem[]> {
  const { rows } = await query<CartItem>(
    `SELECT ci.id, ci.cart_id, ci.product_id, ci.quantity, ci.unit_price,
            p.name AS product_name, p.image_url AS product_image, p.stock AS product_stock
       FROM cart_items ci
       JOIN carts c ON ci.cart_id = c.id
       JOIN products p ON ci.product_id = p.id
      WHERE c.buyer_id = $1
      ORDER BY ci.created_at ASC`,
    [buyerId]
  );
  return rows;
}

export async function clearCart(buyerId: string): Promise<void> {
  await query(
    `DELETE FROM cart_items
      WHERE cart_id IN (SELECT id FROM carts WHERE buyer_id = $1)`,
    [buyerId]
  );
}

export async function removeCartItem(buyerId: string, productId: string): Promise<void> {
  await query(
    `DELETE FROM cart_items
      WHERE product_id = $1
        AND cart_id IN (SELECT id FROM carts WHERE buyer_id = $2)`,
    [productId, buyerId]
  );
}

// ------------------------------------------------------------------
// Orders
// ------------------------------------------------------------------

/**
 * Create an order from the buyer's cart. Does NOT yet reserve a Ramper
 * payment address — that happens in a second step after this returns,
 * because we need the order ID to build the Ramper callback URL.
 */
export async function createOrderFromCart(
  merchantId: string,
  buyerId: string,
  shippingAddress: ShippingAddress,
  shipping: number,
  currencyCode: string
): Promise<Order> {
  return withTransaction(async (client) => {
    const itemsRes = await client.query<{
      product_id: string;
      product_name: string;
      quantity: number;
      unit_price: string;
    }>(
      `SELECT ci.product_id, p.name AS product_name, ci.quantity, ci.unit_price
         FROM cart_items ci
         JOIN carts c ON ci.cart_id = c.id
         JOIN products p ON ci.product_id = p.id
        WHERE c.buyer_id = $1
          FOR UPDATE`,
      [buyerId]
    );

    if (itemsRes.rows.length === 0) {
      throw new Error('Cart is empty');
    }

    for (const item of itemsRes.rows) {
      const stockUpdate = await client.query<{ stock: number }>(
        `UPDATE products
            SET stock = stock - $1
          WHERE id = $2 AND merchant_id = $3 AND stock >= $1
          RETURNING stock`,
        [item.quantity, item.product_id, merchantId]
      );
      if (stockUpdate.rowCount === 0) {
        throw new Error(`Insufficient stock for ${item.product_name}`);
      }
    }

    const subtotal = itemsRes.rows.reduce(
      (sum, item) => sum + Number(item.unit_price) * item.quantity,
      0
    );
    const total = subtotal + shipping;

    const orderRes = await client.query<Order>(
      `INSERT INTO orders (
         merchant_id, buyer_id,
         subtotal, shipping, total, currency_code,
         shipping_address
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [merchantId, buyerId, subtotal, shipping, total, currencyCode, shippingAddress]
    );
    const order = orderRes.rows[0];

    for (const item of itemsRes.rows) {
      await client.query(
        `INSERT INTO order_items (
           order_id, product_id, product_name,
           quantity, unit_price, line_total
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          order.id,
          item.product_id,
          item.product_name,
          item.quantity,
          item.unit_price,
          Number(item.unit_price) * item.quantity,
        ]
      );
    }

    await client.query(
      `DELETE FROM cart_items
        WHERE cart_id IN (SELECT id FROM carts WHERE buyer_id = $1)`,
      [buyerId]
    );

    return order;
  });
}

export async function attachRamperToOrder(
  orderId: string,
  data: {
    ramper_address_in: string;
    ramper_polygon_addr: string;
    payment_url: string;
  }
): Promise<void> {
  await query(
    `UPDATE orders
        SET ramper_address_in = $2, ramper_polygon_addr = $3,
            payment_url = $4
      WHERE id = $1`,
    [orderId, data.ramper_address_in, data.ramper_polygon_addr, data.payment_url]
  );
}

export async function getOrder(merchantId: string, orderId: string): Promise<Order | null> {
  const { rows } = await query<Order>(
    'SELECT * FROM orders WHERE id = $1 AND merchant_id = $2',
    [orderId, merchantId]
  );
  return rows[0] ?? null;
}

export async function getOrderById(orderId: string): Promise<Order | null> {
  const { rows } = await query<Order>('SELECT * FROM orders WHERE id = $1', [orderId]);
  return rows[0] ?? null;
}

export async function markOrderPaid(
  orderId: string,
  data: { value_coin: number; txid_in: string; txid_out: string }
): Promise<boolean> {
  const res = await query(
    `UPDATE orders
        SET status = 'paid',
            paid_at = NOW(),
            value_coin_received = $2,
            txid_in = $3,
            txid_out = $4
      WHERE id = $1 AND status = 'awaiting_payment'`,
    [orderId, data.value_coin, data.txid_in, data.txid_out]
  );
  return res.rowCount > 0;
}

export async function getRecentOrdersForMerchant(
  merchantId: string,
  limit = 50
): Promise<Order[]> {
  const { rows } = await query<Order>(
    `SELECT * FROM orders
      WHERE merchant_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [merchantId, limit]
  );
  return rows;
}

// ------------------------------------------------------------------
// Orders management (dashboard)
// ------------------------------------------------------------------

export interface OrderFilters {
  status?: string;
  since?: Date;
  until?: Date;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface OrderListItem extends Order {
  item_count: number;
  buyer_telegram_username: string | null;
  buyer_telegram_first_name: string | null;
}

export async function listOrdersForMerchant(
  merchantId: string,
  filters: OrderFilters = {}
): Promise<OrderListItem[]> {
  const where: string[] = ['o.merchant_id = $1'];
  const params: unknown[] = [merchantId];
  let i = 2;

  if (filters.status) {
    where.push(`o.status = $${i++}`);
    params.push(filters.status);
  }
  if (filters.since) {
    where.push(`o.created_at >= $${i++}`);
    params.push(filters.since);
  }
  if (filters.until) {
    where.push(`o.created_at <= $${i++}`);
    params.push(filters.until);
  }
  if (filters.search) {
    where.push(
      `(b.first_name ILIKE $${i} OR b.username ILIKE $${i} OR CAST(o.order_number AS TEXT) = $${i})`
    );
    params.push(`%${filters.search}%`);
    i++;
  }

  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = filters.offset ?? 0;

  const { rows } = await query<OrderListItem>(
    `SELECT o.*,
            COALESCE(item_counts.count, 0)::int AS item_count,
            b.username AS buyer_telegram_username,
            b.first_name AS buyer_telegram_first_name
       FROM orders o
       JOIN buyers b ON b.id = o.buyer_id
       LEFT JOIN (
         SELECT order_id, COUNT(*) AS count
           FROM order_items GROUP BY order_id
       ) item_counts ON item_counts.order_id = o.id
      WHERE ${where.join(' AND ')}
      ORDER BY o.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  return rows;
}

export async function countOrdersForMerchant(
  merchantId: string,
  filters: Omit<OrderFilters, 'limit' | 'offset'> = {}
): Promise<number> {
  const where: string[] = ['o.merchant_id = $1'];
  const params: unknown[] = [merchantId];
  let i = 2;

  if (filters.status) {
    where.push(`o.status = $${i++}`);
    params.push(filters.status);
  }
  if (filters.since) {
    where.push(`o.created_at >= $${i++}`);
    params.push(filters.since);
  }
  if (filters.until) {
    where.push(`o.created_at <= $${i++}`);
    params.push(filters.until);
  }
  if (filters.search) {
    where.push(
      `(b.first_name ILIKE $${i} OR b.username ILIKE $${i} OR CAST(o.order_number AS TEXT) = $${i})`
    );
    params.push(`%${filters.search}%`);
    i++;
  }

  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM orders o JOIN buyers b ON b.id = o.buyer_id
      WHERE ${where.join(' AND ')}`,
    params
  );
  return Number(rows[0]?.count ?? 0);
}

export interface OrderDetail extends Order {
  buyer_telegram_id: number | null;
  buyer_telegram_username: string | null;
  buyer_telegram_first_name: string | null;
  items: Array<{
    id: string;
    product_id: string;
    product_name: string;
    quantity: number;
    unit_price: string;
    line_total: string;
  }>;
}

export async function getOrderDetail(
  merchantId: string,
  orderId: string
): Promise<OrderDetail | null> {
  const { rows } = await query<OrderDetail>(
    `SELECT o.*,
            b.telegram_id AS buyer_telegram_id,
            b.username AS buyer_telegram_username,
            b.first_name AS buyer_telegram_first_name
       FROM orders o
       JOIN buyers b ON b.id = o.buyer_id
      WHERE o.merchant_id = $1 AND o.id = $2
      LIMIT 1`,
    [merchantId, orderId]
  );
  if (rows.length === 0) return null;
  const order = rows[0];

  const { rows: items } = await query<{
    id: string;
    product_id: string;
    product_name: string;
    quantity: number;
    unit_price: string;
    line_total: string;
  }>(
    `SELECT id, product_id, product_name, quantity,
            unit_price::text, line_total::text
       FROM order_items WHERE order_id = $1`,
    [orderId]
  );
  order.items = items;
  return order;
}

export async function updateOrderStatus(
  merchantId: string,
  orderId: string,
  status: string,
  extras: {
    tracking_number?: string;
    tracking_carrier?: string;
    tracking_url?: string;
    merchant_notes?: string;
    refund_amount?: number;
  } = {}
): Promise<void> {
  const sets: string[] = ['status = $1', 'updated_at = NOW()'];
  const params: unknown[] = [status];
  let i = 2;

  // Status-specific timestamps
  if (status === 'shipped') sets.push(`shipped_at = COALESCE(shipped_at, NOW())`);
  if (status === 'delivered') sets.push(`delivered_at = COALESCE(delivered_at, NOW())`);
  if (status === 'cancelled') sets.push(`cancelled_at = COALESCE(cancelled_at, NOW())`);
  if (status === 'refunded') sets.push(`refunded_at = COALESCE(refunded_at, NOW())`);

  if (extras.tracking_number !== undefined) {
    sets.push(`tracking_number = $${i++}`);
    params.push(extras.tracking_number || null);
  }
  if (extras.tracking_carrier !== undefined) {
    sets.push(`tracking_carrier = $${i++}`);
    params.push(extras.tracking_carrier || null);
  }
  if (extras.tracking_url !== undefined) {
    sets.push(`tracking_url = $${i++}`);
    params.push(extras.tracking_url || null);
  }
  if (extras.merchant_notes !== undefined) {
    sets.push(`merchant_notes = $${i++}`);
    params.push(extras.merchant_notes || null);
  }
  if (extras.refund_amount !== undefined) {
    sets.push(`refund_amount = $${i++}`);
    params.push(extras.refund_amount);
  }

  params.push(merchantId, orderId);
  await query(
    `UPDATE orders SET ${sets.join(', ')}
      WHERE merchant_id = $${i++} AND id = $${i}`,
    params
  );
}

// ------------------------------------------------------------------
// Metrics (for dashboard overview)
// ------------------------------------------------------------------

export interface MerchantMetrics {
  revenue_today: string;
  revenue_week: string;
  revenue_month: string;
  orders_today: number;
  orders_week: number;
  orders_month: number;
  orders_awaiting_fulfilment: number;
  total_buyers: number;
  low_stock_products: number;
  // Last 30 days, one point per day — for chart
  revenue_series: Array<{ date: string; revenue: string; orders: number }>;
}

export async function getMerchantMetrics(merchantId: string): Promise<MerchantMetrics> {
  const { rows: agg } = await query<{
    revenue_today: string;
    revenue_week: string;
    revenue_month: string;
    orders_today: string;
    orders_week: string;
    orders_month: string;
    orders_awaiting_fulfilment: string;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN paid_at >= date_trunc('day', NOW()) THEN total END), 0)::text AS revenue_today,
       COALESCE(SUM(CASE WHEN paid_at >= NOW() - interval '7 days' THEN total END), 0)::text AS revenue_week,
       COALESCE(SUM(CASE WHEN paid_at >= NOW() - interval '30 days' THEN total END), 0)::text AS revenue_month,
       COUNT(CASE WHEN paid_at >= date_trunc('day', NOW()) THEN 1 END)::text AS orders_today,
       COUNT(CASE WHEN paid_at >= NOW() - interval '7 days' THEN 1 END)::text AS orders_week,
       COUNT(CASE WHEN paid_at >= NOW() - interval '30 days' THEN 1 END)::text AS orders_month,
       COUNT(CASE WHEN status IN ('paid', 'processing') THEN 1 END)::text AS orders_awaiting_fulfilment
       FROM orders WHERE merchant_id = $1`,
    [merchantId]
  );

  const { rows: buyerCountRows } = await query<{ count: string }>(
    `SELECT COUNT(DISTINCT b.id)::text AS count
       FROM buyers b WHERE b.merchant_id = $1`,
    [merchantId]
  );

  const { rows: lowStockRows } = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM products WHERE merchant_id = $1 AND status = 'active' AND stock <= 5`,
    [merchantId]
  );

  const { rows: series } = await query<{
    date: string;
    revenue: string;
    orders: string;
  }>(
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
         ON o.merchant_id = $1
        AND o.paid_at::date = days.d
      GROUP BY days.d ORDER BY days.d`,
    [merchantId]
  );

  const a = agg[0]!;
  return {
    revenue_today: a.revenue_today,
    revenue_week: a.revenue_week,
    revenue_month: a.revenue_month,
    orders_today: Number(a.orders_today),
    orders_week: Number(a.orders_week),
    orders_month: Number(a.orders_month),
    orders_awaiting_fulfilment: Number(a.orders_awaiting_fulfilment),
    total_buyers: Number(buyerCountRows[0]?.count ?? 0),
    low_stock_products: Number(lowStockRows[0]?.count ?? 0),
    revenue_series: series.map((r) => ({
      date: r.date,
      revenue: r.revenue,
      orders: Number(r.orders),
    })),
  };
}

export async function recordRamperCallback(
  orderId: string | null,
  data: { value_coin: number | null; coin: string | null; txid_in: string; txid_out: string },
  rawQuery: Record<string, string>
): Promise<void> {
  await query(
    `INSERT INTO ramper_callbacks (order_id, value_coin, coin, txid_in, txid_out, raw_query)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (txid_in) DO NOTHING`,
    [orderId, data.value_coin, data.coin, data.txid_in, data.txid_out, rawQuery]
  );
}
