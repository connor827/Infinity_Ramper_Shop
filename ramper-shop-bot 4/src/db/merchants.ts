import { query } from './pool.js';
import type { Merchant } from '../types/index.js';

export async function getMerchantById(id: string): Promise<Merchant | null> {
  const { rows } = await query<Merchant>('SELECT * FROM merchants WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function getMerchantByBotToken(token: string): Promise<Merchant | null> {
  const { rows } = await query<Merchant>(
    'SELECT * FROM merchants WHERE bot_token = $1 AND status = $2',
    [token, 'active']
  );
  return rows[0] ?? null;
}

export async function getMerchantByEmail(email: string): Promise<Merchant | null> {
  const { rows } = await query<Merchant>('SELECT * FROM merchants WHERE email = $1', [email]);
  return rows[0] ?? null;
}

export async function listActiveMerchants(): Promise<Merchant[]> {
  const { rows } = await query<Merchant>(
    `SELECT * FROM merchants
     WHERE status = 'active' AND bot_token IS NOT NULL
     ORDER BY created_at DESC`
  );
  return rows;
}

export async function createMerchant(data: {
  email: string;
  password_hash: string;
  store_name: string;
  store_slug: string;
}): Promise<Merchant> {
  const { rows } = await query<Merchant>(
    `INSERT INTO merchants (email, password_hash, store_name, store_slug)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [data.email, data.password_hash, data.store_name, data.store_slug]
  );
  return rows[0];
}

export async function updateMerchantBot(
  merchantId: string,
  bot: { bot_token: string; bot_username: string; bot_id: number }
): Promise<void> {
  await query(
    `UPDATE merchants
        SET bot_token = $2, bot_username = $3, bot_id = $4,
            onboarding_step = 'wallet'
      WHERE id = $1`,
    [merchantId, bot.bot_token, bot.bot_username, bot.bot_id]
  );
}

export async function updateMerchantWallet(
  merchantId: string,
  address: string
): Promise<void> {
  await query(
    `UPDATE merchants
        SET payout_wallet = $2, wallet_verified_at = NOW(),
            onboarding_step = 'store'
      WHERE id = $1`,
    [merchantId, address]
  );
}

export async function activateMerchant(merchantId: string): Promise<void> {
  await query(
    `UPDATE merchants
        SET status = 'active', onboarding_step = 'live'
      WHERE id = $1`,
    [merchantId]
  );
}
