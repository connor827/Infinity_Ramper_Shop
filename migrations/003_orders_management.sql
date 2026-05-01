-- Migration 003: orders management fields
--
-- Extends the orders table with fulfilment tracking so merchants can manage
-- the full order lifecycle from the dashboard.
--
-- Design note: the existing `status` column already has states for
-- 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'
-- so we're extending it rather than introducing a separate fulfilment_status.
-- We add tracking metadata and merchant notes alongside.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS tracking_number   TEXT,
  ADD COLUMN IF NOT EXISTS tracking_carrier   TEXT,
  ADD COLUMN IF NOT EXISTS tracking_url       TEXT,
  ADD COLUMN IF NOT EXISTS merchant_notes     TEXT,
  ADD COLUMN IF NOT EXISTS shipped_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refunded_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refund_amount      NUMERIC(18, 6);
