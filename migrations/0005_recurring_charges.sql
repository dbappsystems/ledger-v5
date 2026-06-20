-- ============================================================================
-- Load Ledger V5 — Migration 0005: Recurring Charges
-- (c) dbappsystems.com | daddyboyapps.com
--
-- PURPOSE
--   recurring_charges — model the STANDING carrier deductions that repeat every
--   settlement period: truck/trailer INSURANCE, PLATE (IRP) installments, and
--   PAYMENT PLANS (e.g. a financed ELD, a settled balance paid down weekly).
--   Until now the driver paystub showed an italic "Recurring charges
--   (insurance, plates, payment plans) — coming next" placeholder with a dash.
--   This table makes that line real, with NOTHING invented: a charge only
--   appears once the carrier creates it, and only inside its own date window.
--
-- WHY A TABLE, NOT A FIELD ON THE DRIVER
--   Truth as Architecture: each standing charge is its own recorded obligation
--   with its own amount, cadence, and lifetime. Insurance can change mid-year;
--   a plate installment ends when the plate is paid; a payment plan has a start
--   and a payoff. One row per obligation keeps the history honest and lets the
--   stub show exactly which charges made up a week's deduction.
--
-- HOW IT HITS THE SETTLEMENT (industry-standard)
--   A charge stores its NATURAL amount and cadence:
--       cadence = 'weekly'   -> `amount` is already the per-week figure.
--       cadence = 'monthly'  -> `amount` is the monthly figure; the settlement
--                               math slices it to the week (amount * 12 / 52)
--                               so a $1,200/mo insurance line shows as its weekly
--                               share on each weekly stub, not the whole month
--                               dumped into one week.
--   A charge only applies to a settlement week whose pay date falls on/after
--   `start_date` and on/before `end_date` (blank end_date = open-ended/active).
--   `active = 0` switches a charge off without deleting its history.
--
-- BEARDS DOCTRINE
--   Transparency of Intent   : every deduction on the stub is a named, dated row.
--   Non-Exploitation         : monthly charges are pro-rated, never front-loaded.
--   Sovereignty of the User  : each tenant owns its own recurring charges.
--   Accountability w/o Exc.  : tenant_id walled like every other data table.
--   Truth as Architecture    : a standing charge is a first-class record.
--
-- Run AFTER 0004, against the v5 DB. Additive — touches no existing table, so
-- current behavior is unchanged until the worker + settlement math read it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS recurring_charges (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  driver        TEXT NOT NULL,                     -- matches drivers.name / load.driver (UPPERCASE)
  charge_type   TEXT NOT NULL DEFAULT 'insurance', -- insurance | plates | payment_plan | other
  label         TEXT NOT NULL DEFAULT '',          -- human line label, e.g. 'Truck Insurance' / 'IRP Plates'
  amount        REAL NOT NULL DEFAULT 0,           -- natural amount for the cadence below
  cadence       TEXT NOT NULL DEFAULT 'weekly',    -- 'weekly' = per-week; 'monthly' = per-month (pro-rated to week)
  start_date    TEXT NOT NULL DEFAULT '',          -- first settlement week this applies (YYYY-MM-DD); '' = always
  end_date      TEXT NOT NULL DEFAULT '',          -- last week this applies; '' = open-ended
  notes         TEXT NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,        -- 0 = switched off, keeps history
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_recur_tenant        ON recurring_charges(tenant_id, active);
CREATE INDEX IF NOT EXISTS idx_recur_tenant_driver ON recurring_charges(tenant_id, driver, active);

-- No seed rows. Recurring charges are real money; the carrier enters its own.
-- The stub shows the live "coming next" placeholder only until the first real
-- charge exists, then it shows the actual lines.
