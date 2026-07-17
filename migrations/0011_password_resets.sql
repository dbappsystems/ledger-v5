-- ============================================================================
-- Load Ledger V5 — Migration 0011: Self-serve password reset
-- (c) dbappsystems.com | daddyboyapps.com
--
-- Backs POST /api/auth/forgot + POST /api/auth/reset (worker/index.js, public
-- routes). A reset token is single-use and short-lived; only its SHA-256 HASH
-- is stored here — the raw token exists only inside the emailed link, so a leak
-- of this table cannot be used to reset anyone's password.
--
-- BEARDS DOCTRINE
--   Sovereignty of the User  -> a locked-out user can recover WITHOUT manual
--                               D1 hash surgery by an operator.
--   Truth as Architecture    -> single-use + expiry enforced by the schema/flow,
--                               not by habit.
--
-- Apply once to load-ledger-v5-db (one statement per call for D1):
--   wrangler d1 execute load-ledger-v5-db --remote --file=migrations/0011_password_resets.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS password_resets (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,        -- matches users.id (INTEGER); keeps JOINs/lookups type-consistent
  tenant_id  TEXT NOT NULL,
  token_hash TEXT NOT NULL,            -- SHA-256 of the raw token (never the raw token)
  expires_at TEXT NOT NULL,            -- ISO; 60-minute TTL set by the worker
  used       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pwreset_token  ON password_resets(token_hash);
CREATE INDEX IF NOT EXISTS idx_pwreset_user   ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS idx_pwreset_tenant ON password_resets(tenant_id);
