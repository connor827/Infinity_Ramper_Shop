// Re-register all merchant Telegram bot webhooks against the current PUBLIC_URL.
// Run after a domain change so existing bots stop pointing at the old hostname.
//
// Usage from project root:
//   npx tsx scripts/reregister-bots.ts
//
// Reads PUBLIC_URL and TELEGRAM_WEBHOOK_SECRET from the same env the server uses.
// Safe to run multiple times — Telegram's setWebhook is idempotent.

import { env } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';
import { logger } from '../src/config/logger.js';

interface MerchantRow {
  id: string;
  bot_token: string | null;
  bot_username: string | null;
  store_name: string;
}

async function main() {
  const { rows } = await pool.query<MerchantRow>(
    `SELECT id, bot_token, bot_username, store_name
       FROM merchants
      WHERE bot_token IS NOT NULL
      ORDER BY created_at`
  );

  console.log(`Found ${rows.length} merchant(s) with bot tokens registered.`);
  console.log(`Re-registering against PUBLIC_URL=${env.PUBLIC_URL}\n`);

  let ok = 0;
  let failed = 0;
  for (const m of rows) {
    if (!m.bot_token) continue;
    // Match the URL pattern used in src/routes/merchant.ts when a bot is
    // first registered, so the webhook path stays consistent.
    const webhookUrl = `${env.PUBLIC_URL}/webhook/telegram/${m.bot_token}`;
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${m.bot_token}/setWebhook`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            url: webhookUrl,
            secret_token: env.TELEGRAM_WEBHOOK_SECRET,
            drop_pending_updates: false, // keep any in-flight updates
          }),
        }
      );
      const body = (await res.json()) as { ok: boolean; description?: string };
      if (body.ok) {
        console.log(`  ok    @${m.bot_username ?? '?'} (${m.store_name})`);
        ok++;
      } else {
        console.log(`  FAIL  @${m.bot_username ?? '?'} — ${body.description}`);
        failed++;
      }
    } catch (err) {
      console.log(`  FAIL  @${m.bot_username ?? '?'} — ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\nDone. ${ok} succeeded, ${failed} failed.`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  logger.error({ err }, 'reregister script crashed');
  process.exit(1);
});
