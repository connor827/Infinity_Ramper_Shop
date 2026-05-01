/**
 * Seed a demo merchant with a couple of products.
 * Run after `npm run migrate`.
 */

import { createMerchant } from '../src/db/merchants.js';
import { createProduct } from '../src/db/shop.js';
import { hashPassword } from '../src/middleware/auth.js';
import { pool } from '../src/db/pool.js';
import { logger } from '../src/config/logger.js';

async function run() {
  const existing = await pool.query(
    `SELECT id FROM merchants WHERE email = 'demo@example.com'`
  );
  if (existing.rows.length > 0) {
    logger.info('demo merchant already exists, skipping seed');
    await pool.end();
    return;
  }

  const merchant = await createMerchant({
    email: 'demo@example.com',
    password_hash: await hashPassword('demo-password-change-me'),
    store_name: 'Demo Shop',
    store_slug: 'demo-shop',
  });

  await createProduct(merchant.id, {
    name: 'Sample widget',
    description: 'A delightful widget of uncertain utility.',
    price: 9.99,
    currency_code: 'USD',
    stock: 100,
  });
  await createProduct(merchant.id, {
    name: 'Premium gizmo',
    description: 'For the discerning gizmo enthusiast.',
    price: 29.99,
    currency_code: 'USD',
    stock: 25,
  });

  logger.info({ merchantId: merchant.id }, 'demo merchant seeded');
  logger.info('email: demo@example.com  password: demo-password-change-me');
  await pool.end();
}

run().catch((err) => {
  logger.error({ err }, 'seed failed');
  process.exit(1);
});
