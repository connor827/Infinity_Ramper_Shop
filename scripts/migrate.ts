/**
 * Dead-simple migration runner.
 *
 * - Creates a `schema_migrations` table
 * - Applies any .sql file in migrations/ whose name is lexicographically
 *   greater than the last applied name
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pool } from '../src/db/pool.js';
import { logger } from '../src/config/logger.js';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

async function run() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows } = await pool.query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY name'
  );
  const applied = new Set(rows.map((r) => r.name));

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let applied_count = 0;

  for (const file of files) {
    if (applied.has(file)) continue;
    logger.info({ file }, 'applying migration');
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied_count++;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, file }, 'migration failed');
      throw err;
    } finally {
      client.release();
    }
  }

  logger.info({ applied_count }, 'migrations complete');
  await pool.end();
}

run().catch((err) => {
  logger.error({ err }, 'migration runner crashed');
  process.exit(1);
});
