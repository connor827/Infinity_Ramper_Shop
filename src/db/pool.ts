import pg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;

// Pass Postgres-side timeouts as connection-time options. This is far
// safer than setting them via a `pool.on('connect')` handler, which races
// with the first query the pool runs against the new client (the pool
// emits 'connect' but does NOT await the handler before handing the
// connection to whoever requested it). We hit that race in production
// and it manifested as a node-postgres deprecation warning that escalated
// into unhandled rejections and process restarts.
//
// statement_timeout: kill any single query that runs > 15s
// idle_in_transaction_session_timeout: abort transactions left open > 30s
//
// The leading `-c ` syntax is how libpq accepts session-level GUC
// settings on connect.
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  options: '-c statement_timeout=15000 -c idle_in_transaction_session_timeout=30000',
});

pool.on('error', (err) => {
  console.error('Unexpected postgres pool error', err);
});

export async function query<T = any>(
  text: string,
  params?: any[]
): Promise<{ rows: T[]; rowCount: number }> {
  const res = await pool.query(text, params);
  return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
}

/**
 * Run a function inside a transaction. If the callback throws, the transaction
 * is rolled back. Otherwise it's committed.
 *
 * Defensive: a rollback that itself throws (because the connection is in
 * a bad state, e.g. a failed DDL or a network blip mid-statement) must
 * not prevent the client from being released back to the pool. Without
 * this guard, repeated transaction failures slowly leak clients until
 * the pool is exhausted and every subsequent request hangs forever
 * waiting for `pool.connect()`.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  let released = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // The connection is unusable. Destroy it so the pool replaces it
      // with a fresh one rather than handing it back to the next caller.
      console.error('rollback failed; destroying client', rollbackErr);
      client.release(rollbackErr as Error);
      released = true;
    }
    throw err;
  } finally {
    if (!released) client.release();
  }
}
