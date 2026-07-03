-- 0006_fuel_reconcile.sql
-- Adds a permanent match key + report metadata to fuel_entries so fuel-card
-- Transaction Reports can be reconciled deterministically against existing
-- (usually estimated) entries.
--
-- Match-key priority for reconciliation:
--   1. invoice_number  (once stored, reconcile is exact forever)
--   2. entry_date + fuel bucket (truck vs refer) as the first-pass fallback
--
-- Fuel bucket mapping from report fuel-type codes:
--   ULSD / ULSR / FUEL  -> truck fuel   (fuel_type='fleet', app "Truck fuel")
--   RFR                 -> refer fuel   (app "Refer fuel")
--   DEFD                -> follows its stop's bucket (truck DEF stays truck)
--
-- All columns nullable / defaulted: applying this to existing rows is safe and
-- backfills nothing destructive.

ALTER TABLE fuel_entries ADD COLUMN invoice_number TEXT DEFAULT '';
ALTER TABLE fuel_entries ADD COLUMN gallons        REAL DEFAULT 0;
ALTER TABLE fuel_entries ADD COLUMN card_last4     TEXT DEFAULT '';
ALTER TABLE fuel_entries ADD COLUMN report_amount  REAL DEFAULT 0;
ALTER TABLE fuel_entries ADD COLUMN reconciled     INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_fuel_invoice
  ON fuel_entries (tenant_id, driver, invoice_number);
CREATE INDEX IF NOT EXISTS idx_fuel_date
  ON fuel_entries (tenant_id, driver, entry_date);
