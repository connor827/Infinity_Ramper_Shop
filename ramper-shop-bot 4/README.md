# Infinity Ramper Shops

Multi-tenant Telegram shop SaaS. Merchants sign up in a web dashboard, connect a Polygon wallet, register a Telegram bot, add products, go live — all self-serve. Buyers shop ins ide the merchant's bot and pay via Infinity Ramper (card, Apple Pay, Google Pay, bank transfer, or crypto). Ramper settles to the merchant's wallet in USDC and splits the platform fee on-chain via its affiliate mechanism.

## Architecture

```
┌────────────┐      ┌──────────────┐      ┌─────────────────┐
│ Merchant   │─────▶│   Express    │─────▶│   Bot engine    │
│ dashboard  │      │   server     │      │ (grammy, shared)│
└────────────┘      └──────────────┘      └─────────────────┘
                           ▲                        │
                           │                        ▼
                    ┌──────────────┐        ┌──────────────┐
                    │   Telegram   │        │  Postgres    │
                    │   buyer      │        │  (tenants)   │
                    └──────────────┘        └──────────────┘
                           │
                           ▼
                    ┌──────────────┐        ┌──────────────┐
                    │   Ramper     │───────▶│   Polygon    │
                    │   checkout   │        │   USDC       │
                    └──────────────┘        └──────────────┘
                           │
                           ▼
                    callback GET /webhook/ramper
```

One Node process hosts everything: the dashboard, the merchant API, Telegram webhooks, Ramper callbacks. Each merchant's bot is a grammy `Bot` instance cached in memory, keyed by its token. When Telegram POSTs an update to `/webhook/telegram/:botToken`, the router looks up the merchant and dispatches the update to the right bot.

## Quick start

```bash
npm install

# Environment
cp .env.example .env
# then edit .env — DATABASE_URL, JWT_SECRET (32+ chars),
# TELEGRAM_WEBHOOK_SECRET (16+ chars), and optionally
# PLATFORM_AFFILIATE_WALLET (see below)

# Database
createdb ramper_shop
npm run migrate
npm run seed   # optional — creates demo@example.com / demo-password-change-me

# Run
npm run dev

# Dashboard: http://localhost:3000
# Health check: http://localhost:3000/healthz
```

For Telegram webhooks during development, run `ngrok http 3000` and set `PUBLIC_URL` to the ngrok URL before onboarding any bots.

## How merchants onboard

1. **Sign up** at `/` — email + password + store name. Gets a JWT, dashboard loads.
2. **Connect bot** — paste a Telegram bot token from [@BotFather](https://t.me/BotFather). The API validates via Telegram's `getMe` and registers the webhook automatically.
3. **Connect wallet** — dashboard shows a message to sign. Merchant signs with MetaMask (or any Polygon wallet), pastes the signature back. `ethers.verifyMessage` confirms ownership.
4. **Store settings** — currency (USD / EUR / GBP / CAD / AUD / INR) and admin Telegram ID (for order notifications).
5. **Add products** — name, description, price, stock, image URL.
6. **Activate** — flips the merchant to `active`. The bot responds to `/start` immediately.

## How payments work

1. Buyer browses the merchant's bot, adds to cart, hits checkout.
2. Bot collects shipping address + email in a session-based flow.
3. On confirm, an order is created atomically (stock decremented transactionally, cart emptied). The bot calls `api.infinityramper.com/control/affiliate.php` (or `wallet.php` if no affiliate configured) with the merchant's payout wallet, the platform's affiliate wallet, and a callback URL containing the order ID.
4. Ramper returns an encrypted `address_in`. The bot builds a Smart Hosted checkout URL at `checkout.infinityramper.com/pay.php` and sends the buyer a "Pay now" button.
5. Buyer completes payment on Ramper's hosted page (picks a provider, pays with card / Apple Pay / Google Pay / bank).
6. Ramper's bot GETs `/webhook/ramper?order_id=...&value_coin=...&txid_in=...&txid_out=...`. The server verifies, marks the order paid, and notifies both buyer and merchant via Telegram.
7. Ramper has already sent the merchant's USDC share to their payout wallet and the platform's share to the affiliate wallet.

No on-chain listener, no custodial funds, no manual fee reconciliation. Ramper handles the money.

## Platform fee

The fee is handled entirely by Ramper's affiliate mechanism. Set `PLATFORM_AFFILIATE_WALLET` in your env to a Polygon USDC address you control. Every payment through your platform will send your share directly to that wallet on-chain. Set this to empty / unset in dev to use plain `wallet.php` with no fee.

`PLATFORM_AFFILIATE_PARAM` controls the query parameter name used when calling `affiliate.php`. The default is `affiliate`. If Ramper documents a different name (or you're on a newer endpoint), override it without changing code.

## Project layout

```
ramper-shop-bot/
├── public/
│   └── index.html              Merchant dashboard (plain HTML + vanilla JS)
├── migrations/
│   ├── 001_initial_schema.sql
│   └── 002_ramper_integration.sql
├── scripts/
│   ├── migrate.ts              Runs pending migrations in order
│   └── seed.ts                 Creates demo merchant + 2 products
├── src/
│   ├── index.ts                Express entry point
│   ├── config/                 Env validation + pino logger
│   ├── db/                     pg pool + merchants / shop repos
│   ├── bot/
│   │   ├── factory.ts          Per-merchant grammy Bot cache
│   │   ├── handlers.ts         Catalogue, cart, checkout, Ramper hand-off
│   │   └── notifications.ts    Post-payment messages to buyer + merchant
│   ├── payments/
│   │   └── ramper.ts           RamperClient (wallet.php, affiliate.php, pay.php, convert.php)
│   ├── routes/
│   │   ├── telegram.ts         Multi-tenant Telegram webhook router
│   │   ├── ramper.ts           Ramper payment-confirmation webhook
│   │   └── merchant.ts         Dashboard REST API
│   ├── middleware/
│   │   └── auth.ts             bcrypt + JWT
│   └── types/
├── package.json
├── tsconfig.json
└── .env.example
```

## Key design choices

- **One database, `merchant_id` on every row.** Simpler than schema-per-tenant, fast enough, easy to back up. Layer Postgres RLS on top in production if you want defense in depth.
- **Bots cached in memory.** First message to a bot loads the merchant and constructs a grammy instance; subsequent messages reuse it. Scales horizontally — any node can serve any bot.
- **Non-custodial.** Funds move buyer → Ramper's temp address → merchant wallet + platform affiliate wallet, all on-chain. The platform never holds money.
- **Stock integrity.** `createOrderFromCart` uses `SELECT ... FOR UPDATE` and a guarded `UPDATE ... WHERE stock >= $1` to prevent overselling under concurrent checkouts.
- **Webhook security.** Telegram's optional `secret_token` header verifies every incoming webhook; the bot token in the URL routes to the right tenant.

## What's still placeholder

Clearly marked in code comments — not oversights.

- **Ramper affiliate param name.** The exact query-parameter name Ramper expects for `affiliate.php` isn't in the public Postman docs. The code defaults to `affiliate`; override via `PLATFORM_AFFILIATE_PARAM` when confirmed.
- **Session store.** grammy's in-memory session is fine for a single-node deploy. Switch to `@grammyjs/storage-redis` before scaling horizontally.
- **Shipping rates.** Hardcoded to zero in checkout. Add per-merchant shipping rules (weight-based, flat-rate, etc.) when merchants ask.
- **Product variants, bulk pricing, reviews.** Not in MVP. Add when real merchants ask.
- **Rate limiting.** No rate limits on the API or bot. Add before production.

## Deployment

Standard Node process. Recommended:

- **Host:** Fly.io, Railway, or Render — all have free tiers that handle this comfortably for early merchants.
- **Database:** Supabase or Neon for Postgres.
- **Logs:** pino output goes to stdout — pipe to your host's log aggregator.

Set `PUBLIC_URL` to your deployed origin (e.g. `https://shops.yourdomain.com`) before onboarding merchants — both the Telegram webhook and the Ramper callback URL depend on it.

## License

MIT.
