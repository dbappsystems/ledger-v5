-- ============================================================================
-- Load Ledger V5 — Migration 0002: Per-Tenant White-Label Settings
-- (c) dbappsystems.com | daddyboyapps.com
--
-- PURPOSE
--   Move every client-specific value OUT of the code and INTO the tenant row,
--   so each company sets its own split, branding, and labels through the app.
--   No more BRUCE/TIM, no more 90/10, no more ETTR/Edgerton in the codebase.
--
-- BEARDS DOCTRINE
--   Sovereignty of the User : each tenant owns and controls its own settings.
--   Truth as Architecture   : the split is data the tenant sets, not a constant
--                             hidden in the source.
--
-- Run AFTER 0001. ALTER TABLE block is run-once.
-- ============================================================================

-- Per-tenant white-label + business settings.
-- driver_split_pct = the % the OWNER/company keeps off the top.
--   Stored as a whole number 1..50 (e.g. 10 = the old "90/10" where owner keeps 10%).
--   App enforces the 1..50 range; customary is 5..25.
ALTER TABLE tenants ADD COLUMN driver_split_pct REAL NOT NULL DEFAULT 10;

-- White-label branding (shown in the app instead of any hardcoded ETTR/Edgerton).
ALTER TABLE tenants ADD COLUMN display_name   TEXT NOT NULL DEFAULT '';   -- e.g. company name in the header
ALTER TABLE tenants ADD COLUMN logo_url       TEXT NOT NULL DEFAULT '';   -- tenant's own logo
ALTER TABLE tenants ADD COLUMN brand_color    TEXT NOT NULL DEFAULT '#0A1628';
ALTER TABLE tenants ADD COLUMN support_email  TEXT NOT NULL DEFAULT '';

-- Invoice / billing identity (replaces hardcoded carrier info on invoices).
ALTER TABLE tenants ADD COLUMN legal_name     TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN mc_number      TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN dot_number     TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN remit_address  TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN remit_email    TEXT NOT NULL DEFAULT '';

-- Seed the existing default tenant (Bruce/Tim's data) with their CURRENT real
-- values so nothing changes for them at cutover. New tenants get blanks they
-- fill in themselves at signup.
UPDATE tenants
   SET driver_split_pct = 10,
       display_name     = 'Edgerton Truck and Trailer',
       legal_name       = 'Edgerton Truck and Trailer',
       support_email    = ''
 WHERE id = '00000000-0000-0000-0000-000000000001';

-- ============================================================================
-- AFTER THIS: the app reads tenant settings (split, branding, invoice identity)
-- from the tenants row resolved by the session token. The settlement math takes
-- the split as a parameter from the tenant, not from a hardcoded constant.
-- ============================================================================
