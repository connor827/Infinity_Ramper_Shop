-- Migration 007 — Shipping options
-- Adds per-merchant shipping options surfaced to the buyer at checkout.
-- Each option has a name, a price, and an optional free-shipping threshold.
-- When the cart subtotal meets/exceeds the threshold, the effective price
-- becomes zero (the option is "free" for that order).
--
-- We also add shipping_option_name to orders so the chosen option is
-- preserved on the order record (for receipts, the merchant order list,
-- and CSV export). Nullable: legacy orders predating this migration, and
-- orders placed when the merchant has no options configured at all, will
-- have NULL here.

CREATE TABLE shipping_options (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id     UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    price           NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
    -- NULL = no threshold (price always applies). When set, subtotals
    -- greater than or equal to the threshold get free shipping for this option.
    free_threshold  NUMERIC(12, 2) CHECK (free_threshold IS NULL OR free_threshold > 0),
    position        INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (merchant_id, name)
);

CREATE INDEX idx_shipping_options_merchant
    ON shipping_options(merchant_id, position);

CREATE TRIGGER trg_shipping_options_updated_at
    BEFORE UPDATE ON shipping_options
    FOR EACH ROW
    EXECUTE FUNCTION touch_updated_at();

-- Record which shipping option the buyer chose at checkout. We store the
-- NAME rather than an FK because the merchant might rename or delete the
-- option later, and the order should still show what the buyer paid for.
ALTER TABLE orders
    ADD COLUMN shipping_option_name TEXT;
