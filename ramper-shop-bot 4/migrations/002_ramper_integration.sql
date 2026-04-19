-- =========================================================================
-- Ramper integration: per-merchant currency, admin telegram id, payment URL
-- Ramper handles the platform fee via its affiliate split, so no fee-owed
-- tracking is needed on our side.
-- =========================================================================

ALTER TABLE merchants
    ADD COLUMN admin_telegram_id BIGINT,
    ADD COLUMN currency_code     CHAR(3) NOT NULL DEFAULT 'USD';

ALTER TABLE products
    RENAME COLUMN price_usdc TO price;

ALTER TABLE products
    ADD COLUMN currency_code CHAR(3);

UPDATE products SET currency_code = 'USD' WHERE currency_code IS NULL;

ALTER TABLE products
    ALTER COLUMN currency_code SET NOT NULL,
    ALTER COLUMN currency_code SET DEFAULT 'USD';

ALTER TABLE orders RENAME COLUMN subtotal_usdc TO subtotal;
ALTER TABLE orders RENAME COLUMN shipping_usdc TO shipping;
ALTER TABLE orders RENAME COLUMN total_usdc TO total;

ALTER TABLE orders
    ADD COLUMN currency_code        CHAR(3) NOT NULL DEFAULT 'USD',
    ADD COLUMN ramper_address_in    TEXT,
    ADD COLUMN ramper_polygon_addr  TEXT,
    ADD COLUMN payment_url          TEXT,
    ADD COLUMN value_coin_received  NUMERIC(18, 6),
    ADD COLUMN txid_in              TEXT,
    ADD COLUMN txid_out             TEXT;

ALTER TABLE orders
    DROP COLUMN payment_address,
    DROP COLUMN payment_expected_at,
    DROP COLUMN tx_hash;

ALTER TABLE order_items RENAME COLUMN unit_price_usdc TO unit_price;
ALTER TABLE order_items RENAME COLUMN line_total_usdc TO line_total;
ALTER TABLE cart_items RENAME COLUMN unit_price_usdc TO unit_price;

DROP TABLE payment_events;

CREATE TABLE ramper_callbacks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    value_coin      NUMERIC(18, 6),
    coin            TEXT,
    txid_in         TEXT,
    txid_out        TEXT,
    raw_query       JSONB,
    processed       BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (txid_in)
);

CREATE INDEX idx_ramper_callbacks_order ON ramper_callbacks(order_id);
