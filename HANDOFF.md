# Load Ledger V5 — Build Handoff
**(c) dbappsystems.com | daddyboyapps.com**
**Last updated: 2026-06-16**

> Paste this at the start of a new chat to continue the build without re-deriving decisions.

---

## WHO / WHAT
- **Owner:** Daddyboy. Builds on **iPhone only** (Mac available ~1 week out, but phone→GitHub→Cloudflare is the working path; Mac is never in the deploy path).
- **App:** the **dbappsystems app** (Load Ledger). NOT "the Bruce app." Bruce is a **client**; Daddyboy also drives for the company in the app, so both have logins.
- **Goal:** turn the single-operator v4 app into a **multi-tenant SaaS** so ~50 trucking clients each have isolated data (their own brokers, loads, payroll, fuel, maintenance, assets, tax) — nobody sees anyone else's.

## REPOS
- **v4 (LIVE, frozen baseline):** `sign-it-now/load-ledger-v4` — React/Vite + Cloudflare Worker + D1 + R2. Serves ettrapp.com for Bruce & Tim. DO NOT disturb.
- **v5 (in progress):** `dbappsystems/ledger-v5`
  - `main` = clean baseline (protected; nothing merges without a PR).
  - `feat/tenant-wall` = the multi-tenant work.
  - **PR #1 open** = the merge gate. https://github.com/dbappsystems/ledger-v5/pull/1

## STACK (locked)
Cloudflare Workers + Pages + D1 + R2 + GitHub only. No Netlify/Supabase/AWS/Oracle on new projects.

---

## DECISIONS MADE (don't relitigate)
1. **Multi-tenant SaaS, not per-client deployments.** One codebase, one DB, clients separated by `tenant_id`. Reason: updates ship once to everyone; no per-account variable juggling. Per-client isolated Cloudflare deploys were rejected (update burden + clients could walk off with the app).
2. **Retention = continuous value, not lock-in.** Long-term vision is still client-owned storage (iCloud-style) as a premium sovereignty tier. That's the opposite of a cage and is intentional (Beards Doctrine: Sovereignty of the User).
3. **The wall is enforced in code, every query** — `tenant_id` comes from the session token, NEVER from the request body/URL.
4. **Branch flow:** protected `main`, work on feature branches, deploy previews, merge via PR only. This also cures the prior Mac-vs-phone conflict problem (repo is the single source of truth).
5. **v5 uses a NEW, SEPARATE database** (`load-ledger-v5-db`). The live v4 DB is never touched during the build.

---

## DONE (committed to feat/tenant-wall)
- `migrations/0001_add_tenancy.sql` — adds `tenants` + `sessions` tables; `tenant_id` on all **9** data tables (users, loads, brokers, fuel_entries, maintenance_ledger, assets, asset_payments, escrow_payments, driver_credentials); backfills legacy rows to a default tenant; per-tenant indexes + uniqueness; adds `salt` column.
- `worker/index.js` — every route rewritten tenant-scoped; new session-token auth via `requireTenant()`.
- Security hardening included: plaintext passwords → SHA-256+salt (auto-upgrades on next login, no lockout); real session tokens w/ 12h expiry; R2 files namespaced `{tenant_id}/...` and ownership-checked.
- Role model: v4's hardcoded TIM god-mode / NICOLE bookkeeper → generalized `role` ('owner'/'bookkeeper'/'driver').
- On `main`: `package.json` (v5) + v5-isolated `worker/wrangler.toml` (points at `load-ledger-v5-db`, account_id kept out of repo).

## NOT DONE / NEXT (in order)
1. **Bring v4 frontend `.jsx` files into v5** (App, Loads, Invoice, Tax, Maintenance, Assets, BrokerDirectory, DriverProfile, BookkeeperProfile, RateCon, SettlementReport, settlementMath.js, main.jsx, index.css, index.html, vite.config.js). Best done as a one-command git mirror at the Mac (can't conflict; `main` is the only target). These DON'T need tenant changes — they call the worker.
2. **Wire frontend auth:** store the session token from login; send `Authorization: Bearer <token>` on every API call; handle 401 → re-login.
3. **Create `load-ledger-v5-db`** in Cloudflare; put its id in `worker/wrangler.toml`.
4. **Apply migration 0001** to that new DB.
5. **Cross-tenant isolation test:** log in as Tenant A, attempt to read Tenant B's data, assert empty. Must pass before merge.
6. **Then** merge PR #1 → `main`.
7. Later: client-storage/sovereignty premium tier; white-label config layer for new clients.

## DO-NOT / GUARDRAILS
- No deploy and no live-DB migration until at the Mac, with a backup taken that day (Cloudflare redundancy != protection against our own bad command).
- Never request tokens/keys/secrets in chat. Secrets live in Cloudflare (e.g. ANTHROPIC_API_KEY).
- Keep account_id/database_id out of committed config (env/dashboard instead).
