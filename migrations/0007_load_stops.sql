-- 0007_load_stops.sql
-- Per-stop child table for loads. This is the ADDRESS-TO-ADDRESS spine: every
-- pickup and delivery on a load is stored as its own row with a real street
-- address and geocoded lat/lon, sequenced in the order the truck runs them.
--
-- WHY THIS EXISTS
--   IFTA mileage is miles-driven-per-state. Accurate state attribution requires
--   the ACTUAL stop coordinates, routed point-to-point over real roads, so the
--   state lines the route crosses fall out of geography — not an estimate and
--   not a PC*Miler verification gate. A load's origin/destination text columns
--   cannot do this; only structured per-stop coordinates can. This table is
--   what the IFTA section reads to build each load's route.
--
-- KEYING
--   load_id  -> loads.id (TEXT). tenant_id carried on every row to match the
--   app's tenant-scoped query pattern. One load has many stops.
--
-- STOP TYPE
--   'pickup' or 'delivery'. Deadhead legs are derived between routed stops by
--   the mileage engine, not stored here.
--
-- GEOCODING
--   lat/lon populated at load-creation time by the Worker geocoder. Nullable so
--   a stop can be saved before geocoding resolves; geocoded_at stamps success.
--   All columns nullable / defaulted: safe to apply with zero existing rows.

CREATE TABLE IF NOT EXISTS load_stops (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT,
  load_id       TEXT NOT NULL,
  sequence      INTEGER DEFAULT 0,
  stop_type     TEXT DEFAULT 'delivery',
  address       TEXT DEFAULT '',
  city          TEXT DEFAULT '',
  state         TEXT DEFAULT '',
  zip           TEXT DEFAULT '',
  lat           REAL,
  lon           REAL,
  appointment   TEXT DEFAULT '',
  geocoded_at   TEXT DEFAULT '',
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_load_stops_load
  ON load_stops (tenant_id, load_id, sequence);
CREATE INDEX IF NOT EXISTS idx_load_stops_state
  ON load_stops (tenant_id, state);
