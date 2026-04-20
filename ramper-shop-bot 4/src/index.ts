import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { telegramRouter } from './routes/telegram.js';
import { merchantRouter } from './routes/merchant.js';
import { ramperRouter } from './routes/ramper.js';
import { pool } from './db/pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json({ limit: '1mb' }));

// --- Health -----------------------------------------------------------------
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, env: env.NODE_ENV });
});

// --- Merchant API (before static, so /api/* doesn't get caught) ------------
app.use('/api', merchantRouter);

// --- Telegram webhooks ------------------------------------------------------
app.use('/', telegramRouter);

// --- Ramper webhooks --------------------------------------------------------
app.use('/', ramperRouter);

// --- Dashboard (static HTML) -----------------------------------------------
// At runtime this file is at /app/dist/src/index.js, so ../../public.
// In dev (tsx from src/), it's /app/src/index.ts, so ../public.
// Try both and use whichever exists.
import { existsSync } from 'node:fs';
const publicCandidates = [
  path.resolve(__dirname, '..', '..', 'public'),  // production: dist/src/ -> public/
  path.resolve(__dirname, '..', 'public'),         // dev: src/ -> public/
];
const publicDir = publicCandidates.find(existsSync) ?? publicCandidates[0];
logger.info({ publicDir }, 'serving dashboard from');

// Clean URLs for dashboard pages: /dashboard/orders -> dashboard/orders.html
const DASHBOARD_PAGES = ['orders', 'products', 'customers', 'bot', 'settings'];
app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(publicDir, 'dashboard', 'index.html'));
});
for (const p of DASHBOARD_PAGES) {
  app.get(`/dashboard/${p}`, (_req, res) => {
    res.sendFile(path.join(publicDir, 'dashboard', `${p}.html`));
  });
}

app.use(express.static(publicDir));

// --- Generic error handler --------------------------------------------------
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, 'unhandled request error');
  res.status(500).json({ error: 'internal error' });
});

// --- Startup ----------------------------------------------------------------

async function main() {
  await pool.query('SELECT 1');
  logger.info('database reachable');

  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, url: env.PUBLIC_URL }, 'server listening');
  });
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});

// --- Graceful shutdown ------------------------------------------------------

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Never crash on a stray rejection — log it and keep running. A crashed
// Node process + Railway restart takes ~30s, during which Telegram webhooks
// fail and callback queries expire, which throws more errors, which would
// crash again. Prefer to log and recover.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection (continuing)');
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaught exception (continuing)');
});
