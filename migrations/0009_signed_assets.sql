-- migrations/0009_signed_assets.sql
-- (c) dbappsystems.com | daddyboyapps.com
-- Load Ledger V5 — signed_assets
--
-- Short-lived, tenant-scoped, non-guessable links to R2 objects, so the
-- 12-hour session token never rides in an asset URL (browser history, logs,
-- Referer). A row is minted only AFTER the worker re-verifies the caller owns
-- the asset; the row stores the tenant_id and the SERVER-COMPUTED canonical R2
-- key — never a client-supplied path. GET /api/signed/:token streams the object
-- if the row exists and has not expired. TTL-only (no single-use), so a
-- receipt opened in a new tab (two requests) still works.
--
-- No PII stored: only tenant_id + the R2 key + content_type + expiry.

CREATE TABLE IF NOT EXISTS signed_assets (
  token        TEXT PRIMARY KEY,          -- crypto.randomUUID(), the bearer of permission
  tenant_id    TEXT NOT NULL,             -- scopes the object to its tenant
  r2_key       TEXT NOT NULL,             -- server-computed canonical key, e.g. ten_x/invoices/abc.pdf
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  asset_type   TEXT NOT NULL DEFAULT '',  -- 'invoice'|'ratecon'|'ratecon-file'|'credential'|'maintenance'|'fuel' (audit)
  asset_id     TEXT NOT NULL DEFAULT '',  -- the id/loadId/driver+key it was minted for (audit)
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL             -- ISO8601; GET past this returns 410
);

-- Expiry sweeps and token lookups.
CREATE INDEX IF NOT EXISTS idx_signed_assets_expires ON signed_assets (expires_at);
CREATE INDEX IF NOT EXISTS idx_signed_assets_tenant  ON signed_assets (tenant_id);
