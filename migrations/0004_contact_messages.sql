-- migrations/0004_contact_messages.sql
-- (c) dbappsystems.com | daddyboyapps.com
-- Load Ledger V5 — in-app contact / support messages.
--
-- ADDITIVE ONLY. Creates one new table. Touches no existing table, column, or
-- row. Safe to apply to the live database without risk to loads, invoices,
-- settlements, or any other data.
--
-- PURPOSE
--   Authenticated, in-app communication from a tenant to dbappsystems. Because
--   the sender is already logged in, identity (tenant_id + driver) is taken from
--   the verified session in the Worker — never from the request body — so every
--   message is provably tied to a real tenant account. No public form, no
--   captcha, no spam surface.
--
-- THE WALL
--   tenant_id is stamped on every row from the session and every read is
--   filtered by tenant_id, identical to every other table in this schema.

CREATE TABLE IF NOT EXISTS contact_messages (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  user_id     TEXT,            -- the users.id of the sender (from the session)
  driver      TEXT,            -- sender's driver_name at time of sending
  subject     TEXT DEFAULT '',
  message     TEXT NOT NULL,
  status      TEXT DEFAULT 'open',   -- open | read | closed (for future triage)
  created_at  TEXT DEFAULT (datetime('now'))
);

-- Read pattern: newest-first within a tenant.
CREATE INDEX IF NOT EXISTS idx_contact_messages_tenant
  ON contact_messages (tenant_id, created_at DESC);
