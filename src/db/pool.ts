import pg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
});

// On every new connection the pool establishes, set Postgres-side timeouts.
// Without these, an INSERT against a missing column (or a transaction left
// in 'idle in transaction') can hang forever, slowly exhausting the pool
// until every request blocks on pool.connect(). 15s is plenty for any
// well-behaved query in this app.
//
// Note: the two SETs must run sequentially. node-postgres clients can only
// execute one query at a time; firing both in parallel causes the second
// to throw mid-flight and flood the process with unhandled rejections.
pool.on('connect', (client) => {
  (async () => {
    try {
      await client.query("SET statement_timeout = '15s'");
      await client.query("SET idle_in_transaction_session_timeout = '30s'");
    } catch {
      /* non-fatal — connection will still work, just less protected */
    }
  })();
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
