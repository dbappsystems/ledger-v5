-- 0008_ifta_miles.sql
-- Ongoing ESTIMATED IFTA mileage ledger. One row per (load, state, leg type).
-- Filled by the Worker mileage engine after a load's stops are geocoded:
-- the route between sequenced stops is computed over real highways with a
-- truck (driving-hgv) profile, the geometry is split at state lines, and the
-- per-state segment miles are written here. Deadhead legs (last delivery ->
-- next pickup) get their own rows with leg_type='deadhead'.
--
-- ACCOUNTING MODEL (IFTA standard): quarterly filing = total miles driven per
-- jurisdiction. Quarter report = SELECT state, SUM(miles) WHERE entry_date in
-- quarter GROUP BY state. Loaded + deadhead both count; the sum of all state
-- rows for a load must equal that load's routed total (integrity check).
--
-- SOURCE FLAG: 'routed' = truck-profile routed miles (ORS driving-hgv);
-- 'estimated' = fallback routing (OSRM car profile) — rougher, still flagged.
-- ALL rows are estimates: verify against PC*Miler before filing.
--
-- Additive only. Safe to apply with zero existing rows. Applied to live D1
-- 2026-07-03.

CREATE TABLE IF NOT EXISTS ifta_miles (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT,
  driver      TEXT DEFAULT '',
  load_id     TEXT DEFAULT '',
  entry_date  TEXT DEFAULT '',          -- delivery date of the load (quarter attribution)
  state       TEXT DEFAULT '',          -- 2-letter jurisdiction code
  miles       REAL DEFAULT 0,
  leg_type    TEXT DEFAULT 'loaded',    -- 'loaded' | 'deadhead'
  source      TEXT DEFAULT 'routed',    -- 'routed' (truck profile) | 'estimated' (fallback)
  notes       TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ifta_miles_driver_date
  ON ifta_miles (tenant_id, driver, entry_date);
CREATE INDEX IF NOT EXISTS idx_ifta_miles_state
  ON ifta_miles (tenant_id, state);
CREATE INDEX IF NOT EXISTS idx_ifta_miles_load
  ON ifta_miles (tenant_id, load_id);
