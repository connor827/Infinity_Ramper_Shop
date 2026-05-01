import pg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;

// Keep the pool config as plain as possible. We've previously tried both
// a `pool.on('connect')` handler and the libpq `options: '-c ...'` route
// to set Postgres-side statement timeouts; both triggered a node-postgres
// deprecation warning by racing with the connection's authentication flow.
// Connection timeouts are protected at the application layer instead
// (Express request timeout + sensible query design), and the underlying
// migration-mismatch bug that originally exhausted the pool has been fixed.
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
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
