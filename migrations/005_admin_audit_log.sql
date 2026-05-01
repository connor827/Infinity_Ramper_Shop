-- Migration 005: admin audit log
-- Every deliberate action taken by an admin gets a row here.
-- Immutable by design: never UPDATE or DELETE from this table.

CREATE TABLE IF NOT EXISTS admin_actions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_email  TEXT NOT NULL,
  action       TEXT NOT NULL,
  target_merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
  metadata     JSONB,
  ip_address   INET,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_actions_created_at_idx ON admin_actions(created_at DESC);
CREATE INDEX IF NOT EXISTS admin_actions_target_idx ON admin_actions(target_merchant_id) WHERE target_merchant_id IS NOT NULL;
