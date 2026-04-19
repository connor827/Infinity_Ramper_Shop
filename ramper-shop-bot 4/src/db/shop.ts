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
