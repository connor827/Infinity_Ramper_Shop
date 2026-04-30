-- Migration 006 — Product categories
-- Adds per-merchant product categories used as visual grouping in the
-- merchant dashboard and as section headers in the Telegram bot.
--
-- Each product belongs to AT MOST one category. Categories are scoped to
-- a single merchant. Deleting a category sets its products' category_id
-- to NULL ('uncategorised') rather than cascading.

BEGIN;

CREATE TABLE product_categories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id     UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    position        INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- A merchant cannot have two categories with the same name
    UNIQUE (merchant_id, name)
);

CREATE INDEX idx_product_categories_merchant
    ON product_categories(merchant_id, position);

-- Touch updated_at on row updates (mirrors the pattern used elsewhere)
CREATE TRIGGER trg_product_categories_updated_at
    BEFORE UPDATE ON product_categories
    FOR EACH ROW
    EXECUTE FUNCTION touch_updated_at();

ALTER TABLE products
    ADD COLUMN category_id UUID
    REFERENCES product_categories(id) ON DELETE SET NULL;

CREATE INDEX idx_products_category ON products(category_id);

COMMIT;
