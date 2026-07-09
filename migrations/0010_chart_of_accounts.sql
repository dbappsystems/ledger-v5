-- 0010_chart_of_accounts.sql
-- Load Ledger V5 — General Ledger / Chart of Accounts layer
-- ADDITIVE ONLY. No existing row is modified. No column is dropped.
-- Every added column is nullable with no default, so the live app is unaffected
-- until code begins reading/writing tax_account_code.
--
-- Design facts (Edgerton, verified):
--   * Every driver is a 1099 leased owner-operator -> each files their own Schedule C.
--   * Carrier split (Daddyboy Rule) applies to every driver, no exemption.
--   * Tim's fuel is ALWAYS Tim's expense: fleet-card (fuel_entries) AND
--     out-of-pocket (maintenance_ledger category='Fuel') both map to the SAME
--     driver Schedule C fuel line, sourced from two tables. Edgerton never books fuel.

-- ---------------------------------------------------------------------------
-- 1. The account master (chart of accounts). One row per bookkeeping account.
--    Scoped by tenant so each white-label tenant can extend its own chart,
--    seeded with the IRS Schedule C standard lines shared by all tenants
--    (tenant_id = '_standard').
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gl_accounts (
  code           TEXT NOT NULL,              -- stable machine code, e.g. 'SCHED_C_09_FUEL'
  tenant_id      TEXT NOT NULL DEFAULT '_standard',
  schedule       TEXT NOT NULL,              -- 'SCHEDULE_C' | 'BALANCE_SHEET' | 'NON_DEDUCTIBLE'
  line_ref       TEXT,                       -- IRS line reference, e.g. '9', '10', '22', 'Part III'
  label          TEXT NOT NULL,              -- human label, e.g. 'Car and truck expenses - Fuel'
  side           TEXT NOT NULL,              -- 'EXPENSE' | 'INCOME' | 'ASSET' | 'LIABILITY'
  owner_scope    TEXT NOT NULL,              -- 'DRIVER' (posts to driver Sched C) | 'CARRIER' (Edgerton)
  deductible_pct REAL NOT NULL DEFAULT 100,  -- e.g. per diem 80, most 100, non-deductible 0
  active         INTEGER NOT NULL DEFAULT 1,
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, code)
);

-- ---------------------------------------------------------------------------
-- 2. Additive nullable tax_account_code on every source table that produces a
--    settlement / tax line. NULL = not yet classified (safe; app ignores it
--    until the GL reader is switched on). Each references gl_accounts.code.
-- ---------------------------------------------------------------------------
ALTER TABLE loads              ADD COLUMN tax_account_code TEXT;   -- base_pay -> income lines
ALTER TABLE expenses           ADD COLUMN tax_account_code TEXT;   -- per-load lumper/incidental/etc.
ALTER TABLE fuel_entries       ADD COLUMN tax_account_code TEXT;   -- fleet-card fuel -> driver fuel
ALTER TABLE maintenance_ledger ADD COLUMN tax_account_code TEXT;   -- repairs/parts/out-of-pocket fuel
ALTER TABLE carrier_advances   ADD COLUMN tax_account_code TEXT;   -- balance-sheet loan, not expense
ALTER TABLE recurring_charges  ADD COLUMN tax_account_code TEXT;   -- insurance/lease/escrow/etc.
ALTER TABLE escrow_payments    ADD COLUMN tax_account_code TEXT;   -- balance-sheet held fund
ALTER TABLE asset_payments     ADD COLUMN tax_account_code TEXT;   -- truck/trailer -> depreciation

-- ---------------------------------------------------------------------------
-- 3. Seed the standard IRS Schedule C chart (tenant_id='_standard').
--    These are the lines a leased owner-operator actually uses.
--    Codes are stable; labels/line_refs follow the current Schedule C.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO gl_accounts (code, tenant_id, schedule, line_ref, label, side, owner_scope, deductible_pct, notes) VALUES
  ('SCHED_C_01_GROSS',       '_standard','SCHEDULE_C','1',  'Gross receipts (line-haul revenue)',        'INCOME','DRIVER',100,'base_pay + accessorials billed'),
  ('SCHED_C_ACCESSORIAL',    '_standard','SCHEDULE_C','1',  'Accessorial income (detention, etc.)',      'INCOME','DRIVER',100,'detention, layover, tarp'),
  ('CARRIER_COMMISSION_INC', '_standard','SCHEDULE_C','1',  'Carrier commission income (split retained)','INCOME','CARRIER',100,'Daddyboy Rule: every driver, no exemption'),
  ('SCHED_C_09_FUEL',        '_standard','SCHEDULE_C','9',  'Car and truck expenses - Fuel',             'EXPENSE','DRIVER',100,'BOTH fleet-card and out-of-pocket fuel land here for the driver'),
  ('SCHED_C_09_MAINT',       '_standard','SCHEDULE_C','9',  'Car and truck expenses - Repairs/Maint',    'EXPENSE','DRIVER',100,'repairs, parts, tires'),
  ('SCHED_C_10_COMMISSION',  '_standard','SCHEDULE_C','10', 'Commissions and fees (carrier split paid)', 'EXPENSE','DRIVER',100,'the carrier split as it hits the driver return'),
  ('SCHED_C_15_INSURANCE',   '_standard','SCHEDULE_C','15', 'Insurance (occ/acc, cargo, phys dmg)',       'EXPENSE','DRIVER',100,NULL),
  ('SCHED_C_16B_INTEREST',   '_standard','SCHEDULE_C','16b','Interest - truck loan',                     'EXPENSE','DRIVER',100,'loan interest deductible; principal is not'),
  ('SCHED_C_20A_LEASE_EQUIP','_standard','SCHEDULE_C','20a','Rent/lease - equipment (trailer/truck)',    'EXPENSE','DRIVER',100,'lease-purchase / trailer rent'),
  ('SCHED_C_22_SUPPLIES',    '_standard','SCHEDULE_C','22', 'Supplies (straps, gloves, PPE, etc.)',       'EXPENSE','DRIVER',100,NULL),
  ('SCHED_C_23_TAXLIC',      '_standard','SCHEDULE_C','23', 'Taxes and licenses (permits, IFTA, IRP)',    'EXPENSE','DRIVER',100,NULL),
  ('SCHED_C_24A_TOLLS',      '_standard','SCHEDULE_C','24a','Travel - tolls and scales',                 'EXPENSE','DRIVER',100,'reimbursements pass through here'),
  ('SCHED_C_24B_PERDIEM',    '_standard','SCHEDULE_C','24b','Meals - per diem (DOT)',                    'EXPENSE','DRIVER',80,'DOT per diem, 80% deductible'),
  ('SCHED_C_27_LUMPER',      '_standard','SCHEDULE_C','27a','Other - lumper fees',                       'EXPENSE','DRIVER',100,NULL),
  ('SCHED_C_27_OTHER',       '_standard','SCHEDULE_C','27a','Other expenses',                            'EXPENSE','DRIVER',100,'catch-all, itemized in notes'),
  ('SCHED_C_13_DEPREC',      '_standard','SCHEDULE_C','13', 'Depreciation / Section 179 (truck/trailer)','EXPENSE','DRIVER',100,'asset_payments principal -> basis; depreciation, not expense'),
  ('BS_DRIVER_ADVANCE',      '_standard','BALANCE_SHEET','asset','Driver advance receivable (loan)',     'ASSET','CARRIER',0,'carrier_advances: loan out, repaid from settlement. NOT an expense'),
  ('BS_ESCROW_HELD',         '_standard','BALANCE_SHEET','liability','Driver escrow held (refundable)',  'LIABILITY','CARRIER',0,'escrow_payments: money held for driver, refundable. NOT income'),
  ('BS_BROKER_ADVANCE',      '_standard','BALANCE_SHEET','contra','Broker advance (Comdata) - billing',  'ASSET','DRIVER',0,'nets against lumpers/incidentals on broker invoice; not a Sched C line');
