-- ============================================================================
-- Load Ledger V5 — Migration 0001: Multi-Tenant Foundation
-- (c) dbappsystems.com | daddyboyapps.com
--
-- Runs against the NEW v5 database (load-ledger-v5-db). Does NOT touch the
-- live v4 database. Brings tenancy in from a clean slate.
--
-- BEARDS DOCTRINE
--   Truth as Architecture        -> separation enforced by schema, not habit
--   Accountability w/o Exception -> EVERY data table carries tenant_id, no gaps
--   Sovereignty of the User      -> each tenant's rows are walled by construction
--
-- Apply statements in order. The ALTER TABLE block is run-once.
-- ============================================================================

-- 1) TENANTS ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id           TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  slug         TEXT UNIQUE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Default tenant for the first migrated dataset (Bruce/Tim -> ettrapp).
INSERT OR IGNORE INTO tenants (id, company_name, slug, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Edgerton Truck and Trailer', 'ettr', 'active');

-- 2) SESSIONS ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  tenant_id  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 3) ADD tenant_id TO EVERY DATA TABLE (run once) ---------------------------
ALTER TABLE users               ADD COLUMN tenant_id TEXT;
ALTER TABLE loads               ADD COLUMN tenant_id TEXT;
ALTER TABLE brokers             ADD COLUMN tenant_id TEXT;
ALTER TABLE fuel_entries        ADD COLUMN tenant_id TEXT;
ALTER TABLE maintenance_ledger  ADD COLUMN tenant_id TEXT;
ALTER TABLE assets              ADD COLUMN tenant_id TEXT;
ALTER TABLE asset_payments      ADD COLUMN tenant_id TEXT;
ALTER TABLE escrow_payments     ADD COLUMN tenant_id TEXT;
ALTER TABLE driver_credentials  ADD COLUMN tenant_id TEXT;

-- Add salt column for password hashing upgrade (run once).
ALTER TABLE users ADD COLUMN salt TEXT;

-- 4) BACKFILL EXISTING ROWS INTO THE DEFAULT TENANT -------------------------
UPDATE users               SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE loads               SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE brokers             SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE fuel_entries        SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE maintenance_ledger  SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE assets              SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE asset_payments      SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE escrow_payments     SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE driver_credentials  SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;

-- 5) INDEXES — every tenant-scoped query filters on tenant_id first ---------
CREATE INDEX IF NOT EXISTS idx_users_tenant   ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_loads_tenant   ON loads(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_brokers_tenant ON brokers(tenant_id, broker_name);
CREATE INDEX IF NOT EXISTS idx_fuel_tenant    ON fuel_entries(tenant_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_maint_tenant   ON maintenance_ledger(tenant_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_assets_tenant  ON assets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_assetpay_tenant ON asset_payments(tenant_id, asset_id);
CREATE INDEX IF NOT EXISTS idx_escrow_tenant  ON escrow_payments(tenant_id, funded_at);
CREATE INDEX IF NOT EXISTS idx_cred_tenant    ON driver_credentials(tenant_id, driver);

-- 6) PER-TENANT UNIQUENESS --------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_email
  ON users(tenant_id, LOWER(email));
-- driver_credentials upsert now keys on (tenant_id, driver):
CREATE UNIQUE INDEX IF NOT EXISTS idx_cred_tenant_driver
  ON driver_credentials(tenant_id, driver);

-- ============================================================================
-- AFTER THIS MIGRATION every data table has tenant_id; the Worker resolves
-- tenant from the session token and injects "WHERE tenant_id = ?" everywhere.
-- ============================================================================
