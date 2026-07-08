-- migrations/0010_settlement_payments.sql
-- (c) dbappsystems.com | daddyboyapps.com
-- Load Ledger V5 — SETTLEMENT PAYMENTS (carrier -> driver disbursements)
--
-- Records money the CARRIER (e.g. Edgerton) actually hands the DRIVER (e.g. Tim)
-- as pay: cash or check. This is the disbursement that pays DOWN what the driver
-- is owed. It is applied OLDEST-LOAD-FIRST (FIFO) against the driver's unpaid
-- loads by the pure reconciler in src/settlementFifo.js — this table only stores
-- the FACT of the payment (who, how much, when, how). No load "status" is written
-- here; the load-card carrier tools (Mark Billed / Mark Paid) are untouched.
--
-- SEPARATION OF SOURCES (Daddyboy spec, 2026-07-08):
--   * cash / check pay .............. THIS table (settlement_payments)
--   * general carrier advance ....... carrier_advances WHERE reason='general'
--       (already money handed to the driver early; the FIFO reconciler treats a
--        general advance the SAME as a cash/check payment — pays oldest load first)
--   * repair advance / escrow ....... NOT part of load paydown. reason='repair'
--       stays a loan against the repair bill; escrow_payments stays the driver's
--       money applied to the repair bill. Neither tops off loads.
--
-- The all-time running balance in settlementMath.js (computeRunningBalance) is a
-- REPORTING number and is deliberately left byte-identical. This table feeds the
-- SEPARATE oldest-first load reconciliation view, not that formula.

CREATE TABLE IF NOT EXISTS settlement_payments (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  driver      TEXT NOT NULL,
  amount      REAL NOT NULL DEFAULT 0,
  paid_at     TEXT NOT NULL,                 -- date carrier handed over the money
  method      TEXT NOT NULL DEFAULT 'cash',  -- 'cash' | 'check' | 'other'
  reference   TEXT NOT NULL DEFAULT '',      -- check # (blank for cash)
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_settlement_payments_driver
  ON settlement_payments (tenant_id, driver, paid_at);
