-- Migration 004: bot customisation
-- Three nullable strings merchants can personalise on their bot.
-- All default to NULL; the bot falls back to its generic copy when NULL.

ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS welcome_message TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS order_received_message TEXT;

-- Reasonable caps enforced at the API layer (welcome 300 chars, description 500, order_received 500).
-- No DB-level length constraint — easier to relax later.
