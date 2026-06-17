-- ============================================================================
-- Load Ledger V5 — Migration 0003: Drivers + Carrier Advances
-- (c) dbappsystems.com | daddyboyapps.com
--
-- PURPOSE
--   1) drivers          — give every tenant a REAL driver list (IDs, flags),
--                         replacing the hardcoded BRUCE/TIM string-matching that
--                         is scattered through Loads, Tax, Maintenance, and the
--                         settlement math. This is the root fix for white-label.
--   2) carrier_advances — model CARRIER->DRIVER direct loans as first-class
--                         settlement deductions, the industry-standard way,
--                         fully separate from broker (comdata) billing.
--
-- THE TWO ADVANCE TYPES (industry-standard accounting) — kept separate:
--   (A) BROKER ADVANCE  = comdata / express code. Broker fronts the driver cash
--       against a load. Lives ENTIRELY on the broker invoice: it nets against
--       lumpers/incidentals; any leftover is money the driver already collected
--       and reduces that driver's settlement. This is UNCHANGED and lives on the
--       load, not here.
--   (B) CARRIER ADVANCE = the carrier sends the driver money directly (breakdown,
--       repair, general). Repaid out of the driver's settlement. THIS TABLE.
--       "Repair advance" is just reason='repair' — no longer its own concept.
--
-- BEARDS DOCTRINE
--   Truth as Architecture   : a driver is a row with an identity, not a string
--                             repeated in code; an advance is a recorded loan.
--   Accountability w/o Exc. : both tables carry tenant_id and are walled like
--                             every other data table.
--   Sovereignty of the User : each tenant owns its own drivers and advances.
--
-- Run AFTER 0002, against the NEW v5 DB only. Additive — does not touch or
-- rewrite any existing table, so current behavior is unchanged until the worker
-- and settlement math begin reading these tables (subsequent commits).
-- ============================================================================

-- 1) DRIVERS ----------------------------------------------------------------
-- One row per driver per tenant. `name` is the canonical uppercase key and, for
-- the transition, MATCHES the existing loads.driver / fuel_entries.driver /
-- maintenance_ledger.driver string so joins work immediately with no data
-- rewrite. is_owner_operator drives the 100%-keep path in settlementMath.calcPay
-- (per-driver, replacing `driver === 'BRUCE'`). color replaces the hardcoded
-- per-driver card/leaderboard colors in Loads.jsx.
--   state_label / state_rate: per-driver STATE INCOME TAX, used by Tax.jsx. This
--   is legitimate per-driver business data (a driver's home state sets the rate),
--   and replaces the hardcoded STATE_RATES{TIM,BRUCE} table in the code. rate is
--   a decimal fraction (0.0530 = 5.30%); label is the human state name. A blank
--   rate (0) means "not set" — Tax.jsx falls back to the tenant owner-operator's
--   state so a new driver isn't taxed at some other client's hardcoded rate.
CREATE TABLE IF NOT EXISTS drivers (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  name              TEXT NOT NULL,                 -- canonical UPPERCASE key (matches existing load.driver)
  display_name      TEXT NOT NULL DEFAULT '',      -- human label for UI; falls back to name if blank
  is_owner_operator INTEGER NOT NULL DEFAULT 0,    -- 1 = keeps 100% of base, no company split
  color             TEXT NOT NULL DEFAULT '#1e88e5',
  state_label       TEXT NOT NULL DEFAULT '',      -- driver's home state name (e.g. 'Wisconsin'); '' = not set
  state_rate        REAL NOT NULL DEFAULT 0,       -- state income tax as a fraction (0.0530 = 5.30%); 0 = not set
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_drivers_tenant ON drivers(tenant_id, active);
-- A driver name is unique within a tenant (but BRUCE can exist in two tenants).
CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_tenant_name ON drivers(tenant_id, name);

-- Seed the existing default tenant's two drivers with their CURRENT identity so
-- nothing changes for the live client. BRUCE is the owner-operator (kept 100% in
-- v4 via the hardcoded name check); TIM is a standard split driver. Colors match
-- the existing hardcoded Loads.jsx leaderboard (#1e88e5 blue / #e53935 red).
-- State tax matches the retired STATE_RATES table: BRUCE = Wisconsin 5.30%,
-- TIM = Illinois 4.95%.
INSERT OR IGNORE INTO drivers (id, tenant_id, name, display_name, is_owner_operator, color, state_label, state_rate, active)
VALUES
  ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-000000000001', 'BRUCE', 'Bruce', 1, '#1e88e5', 'Wisconsin', 0.0530, 1),
  ('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-000000000001', 'TIM',   'Tim',   0, '#e53935', 'Illinois',  0.0495, 1);

-- 2) CARRIER ADVANCES -------------------------------------------------------
-- Carrier -> driver direct loans. A first-class settlement deduction: the amount
-- is owed back by the driver and comes OUT of the driver's settlement until
-- repaid. Separate from broker/comdata billing entirely.
--   reason: 'repair' | 'general' | 'fuel' | 'other'  (standard carrier-advance
--           categories; 'repair' replaces the old special-cased "repair advance")
--   repaid: 0 = still owed (reduces settlement), 1 = settled/closed
--   asset_id: optional link to the truck/asset a repair advance was for
CREATE TABLE IF NOT EXISTS carrier_advances (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  driver        TEXT NOT NULL,                     -- matches drivers.name / load.driver
  amount        REAL NOT NULL DEFAULT 0,
  advance_date  TEXT NOT NULL,
  reason        TEXT NOT NULL DEFAULT 'general',   -- repair | general | fuel | other
  notes         TEXT NOT NULL DEFAULT '',
  asset_id      TEXT NOT NULL DEFAULT '',          -- optional: truck this advance was for
  repaid        INTEGER NOT NULL DEFAULT 0,         -- 0 = still owed, 1 = settled
  repaid_date   TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_carradv_tenant        ON carrier_advances(tenant_id, advance_date);
CREATE INDEX IF NOT EXISTS idx_carradv_tenant_driver ON carrier_advances(tenant_id, driver, repaid);

-- ============================================================================
-- LATER (cutover-day data migration, NOT in this file):
--   * Add loads.driver_id / fuel_entries.driver_id / maintenance_ledger.driver_id
--     FK columns and backfill from drivers.name, then switch the worker + UI to
--     join on driver_id instead of the name string. Done as its own migration
--     with a same-day backup once the drivers table is in use.
--   * The legacy Tim<->Edgerton "financing" entries in maintenance_ledger that
--     represent carrier loans should be migrated into carrier_advances with the
--     appropriate reason; pure repair *expenses* stay in maintenance_ledger.
-- ============================================================================
