-- =========================================================================
-- Infinity Ramper Shops — initial schema
-- Multi-tenant Telegram shop SaaS with on-chain USDC settlement on Polygon
-- =========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -------------------------------------------------------------------------
-- Merchants (tenants)
-- Each merchant owns exactly one bot and one storefront.
-- -------------------------------------------------------------------------
CREATE TABLE merchants (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email               CITEXT UNIQUE,  -- see CITEXT note below
    password_hash       TEXT NOT NULL,
    store_name          TEXT NOT NULL,
    store_slug          TEXT UNIQUE NOT NULL,
    bot_token           TEXT UNIQUE,               -- Telegram bot token
    bot_username        TEXT,                      -- e.g. "MyShopBot"
    bot_id              BIGINT,                    -- numeric bot id from getMe
    payout_wallet       TEXT,                      -- Polygon address (0x...)
    wallet_verified_at  TIMESTAMPTZ,               -- set when signature verified
    currency_display    TEXT NOT NULL DEFAULT 'USDC',
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'active', 'suspended', 'terminated')),
    onboarding_step     TEXT NOT NULL DEFAULT 'signup'
                        CHECK (onboarding_step IN
                            ('signup','bot','wallet','store','products','live')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_merchants_bot_token ON merchants(bot_token);
CREATE INDEX idx_merchants_status ON merchants(status);

-- CITEXT requires the extension; if preferred, use TEXT + LOWER() index
CREATE EXTENSION IF NOT EXISTS citext;
ALTER TABLE merchants ALTER COLUMN email TYPE CITEXT;

-- -------------------------------------------------------------------------
-- Products — tenant scoped
-- -------------------------------------------------------------------------
CREATE TABLE products (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id     UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    sku             TEXT,
    name            TEXT NOT NULL,
    description     TEXT,
    price_usdc      NUMERIC(18, 6) NOT NULL CHECK (price_usdc >= 0),
    image_url       TEXT,
    stock           INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    weight_grams    INTEGER,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'inactive', 'out_of_stock')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_products_merchant ON products(merchant_id);
CREATE INDEX idx_products_merchant_status ON products(merchant_id, status);

-- -------------------------------------------------------------------------
-- Telegram buyer identities — scoped to (merchant, telegram_id)
-- The same telegram account is a distinct buyer record per merchant.
-- -------------------------------------------------------------------------
CREATE TABLE buyers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id     UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    telegram_id     BIGINT NOT NULL,
    username        TEXT,
    first_name      TEXT,
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (merchant_id, telegram_id)
);

-- -------------------------------------------------------------------------
-- Carts (one open cart per buyer per merchant)
-- -------------------------------------------------------------------------
CREATE TABLE carts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id     UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    buyer_id        UUID NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (buyer_id)
);

CREATE TABLE cart_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cart_id         UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
    product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity        INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_usdc NUMERIC(18, 6) NOT NULL,  -- snapshot
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (cart_id, product_id)
);

-- -------------------------------------------------------------------------
-- Orders + payments
-- -------------------------------------------------------------------------
CREATE TABLE orders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id         UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    buyer_id            UUID NOT NULL REFERENCES buyers(id) ON DELETE RESTRICT,
    order_number        SERIAL,  -- human-readable, unique within table; display as #N
    subtotal_usdc       NUMERIC(18, 6) NOT NULL,
    shipping_usdc       NUMERIC(18, 6) NOT NULL DEFAULT 0,
    total_usdc          NUMERIC(18, 6) NOT NULL,
    shipping_address    JSONB,   -- structured address the buyer entered in chat
    status              TEXT NOT NULL DEFAULT 'awaiting_payment'
                        CHECK (status IN (
                            'awaiting_payment', 'paid', 'processing',
                            'shipped', 'delivered', 'cancelled', 'refunded'
                        )),
    payment_address     TEXT,    -- Polygon address the splitter watches
    payment_expected_at TIMESTAMPTZ,
    paid_at             TIMESTAMPTZ,
    tx_hash             TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_merchant ON orders(merchant_id);
CREATE INDEX idx_orders_merchant_status ON orders(merchant_id, status);
CREATE INDEX idx_orders_buyer ON orders(buyer_id);
CREATE INDEX idx_orders_payment_address ON orders(payment_address)
    WHERE payment_address IS NOT NULL;

CREATE TABLE order_items (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id            UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id          UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    product_name        TEXT NOT NULL,          -- snapshot
    quantity            INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_usdc     NUMERIC(18, 6) NOT NULL,
    line_total_usdc     NUMERIC(18, 6) NOT NULL
);

CREATE INDEX idx_order_items_order ON order_items(order_id);

-- -------------------------------------------------------------------------
-- On-chain payment events (audit log of what the chain listener saw)
-- -------------------------------------------------------------------------
CREATE TABLE payment_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
    merchant_id     UUID REFERENCES merchants(id) ON DELETE SET NULL,
    tx_hash         TEXT NOT NULL,
    block_number    BIGINT NOT NULL,
    amount_usdc     NUMERIC(18, 6) NOT NULL,
    from_address    TEXT NOT NULL,
    to_address      TEXT NOT NULL,
    confirmations   INTEGER NOT NULL DEFAULT 0,
    raw             JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tx_hash, to_address)
);

CREATE INDEX idx_payment_events_order ON payment_events(order_id);

-- -------------------------------------------------------------------------
-- Updated-at trigger
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_merchants_updated_at
    BEFORE UPDATE ON merchants
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_products_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_orders_updated_at
    BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_carts_updated_at
    BEFORE UPDATE ON carts
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
