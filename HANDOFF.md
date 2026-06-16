# Load Ledger V5 — Build Handoff
**(c) dbappsystems.com | daddyboyapps.com**
**Last updated: 2026-06-16 (rev 2)**

> Paste this at the start of a new chat to continue the build without re-deriving decisions.
> VERIFY against the live repo before trusting — this doc can drift.

---

## WHO / WHAT
- **Owner:** Daddyboy. Builds on **iPhone only** (Mac ~1 week out; phone→GitHub→Cloudflare is the working path; Mac is never in the deploy path).
- **App:** the **dbappsystems app** (Load Ledger). NOT "the Bruce app." Bruce is a **client**; Daddyboy also drives for the company in the app, so both have logins.
- **Goal:** turn the single-operator v4 app into a **multi-tenant SaaS** so ~50 trucking clients each have isolated data (own brokers, loads, payroll, fuel, maintenance, assets, tax) — nobody sees anyone else's.

## REPOS
- **v4 (LIVE, frozen baseline):** `sign-it-now/load-ledger-v4` — React/Vite + Cloudflare Worker + D1 + R2. Serves ettrapp.com for Bruce & Tim. DO NOT disturb.
- **v5 (in progress):** `dbappsystems/ledger-v5`
  - `main` = now holds the merged tenant-wall worker + migration + tests + CI.
  - `feat/tenant-wall` = original feature branch (merged via PR #1).

## STACK (locked)
Cloudflare Workers + Pages + D1 + R2 + GitHub only. No Netlify/Supabase/AWS/Oracle on new projects.

---

## DECISIONS MADE (don't relitigate)
1. **Multi-tenant SaaS, not per-client deployments.** One codebase, one DB, clients separated by `tenant_id`. Updates ship once to everyone.
2. **Retention = continuous value, not lock-in.** Long-term vision: client-owned storage (iCloud-style) as a premium sovereignty tier (Beards Doctrine: Sovereignty of the User).
3. **The wall is enforced in code, every query** — `tenant_id` comes from the session token, NEVER from the request body/URL.
4. **Branch flow:** protected `main`, feature branches, deploy previews, merge via PR. (Note: PR #1 merged before the isolation test existed — CI now closes that gap.)
5. **v5 uses a NEW, SEPARATE database** (`load-ledger-v5-db`). The live v4 DB is never touched during the build.

---

## DONE (verified on `main`)
- `migrations/0001_add_tenancy.sql` — `tenants` + `sessions` tables; `tenant_id` on all **9** data tables (users, loads, brokers, fuel_entries, maintenance_ledger, assets, asset_payments, escrow_payments, driver_credentials); backfills legacy rows into a default tenant; per-tenant indexes + uniqueness; adds `salt` column.
- `worker/index.js` — every route tenant-scoped; session-token auth via `requireTenant()`. (933 lines, syntax-valid, SHA cf17beb verified.)
- Security hardening: plaintext passwords → SHA-256+salt (auto-upgrade on next login, no lockout); 12h session tokens; R2 files namespaced `{tenant_id}/...` and ownership-checked.
- Roles: v4's hardcoded TIM god-mode / NICOLE bookkeeper → generalized `role` ('owner'/'bookkeeper'/'driver').
- **Tests + CI (the wall is now proven, not just asserted):**
  - `tests/test_tenant_isolation_static.mjs` — scans the worker source; FAILS if any data query loses `tenant_id`. Passed 55 checks; proven to catch an injected leak.
  - `tests/test_tenant_isolation_live.mjs` — end-to-end; logs in as Tenant B, asserts B can't see A's loads/brokers; unauth rejected. Run post-deploy with 2 seeded tenants.
  - `.github/workflows/tenant-wall.yml` — runs the static test on every push + PR (the merge gate).
- **PR #1 = MERGED** (2026-06-16 23:18). Not pending.

## NOT DONE / NEXT (in order)
1. **Cloudflare side (Mac / dashboard):**
   - Create `load-ledger-v5-db` (D1) and `load-ledger-v5-files` (R2).
   - Put the new DB id into `worker/wrangler.toml` (currently `REPLACE_WITH_V5_DB_ID`).
   - Apply `migrations/0001_add_tenancy.sql` to that new DB.
   - Set `ANTHROPIC_API_KEY` as a Worker secret. Set `account_id` via dashboard (kept out of repo).
2. **Run the live isolation test** against the deployed worker (seed 2 tenants first). Must pass before real clients.
3. **Bring v4 frontend `.jsx` into v5** (App, Loads, Invoice, Tax, Maintenance, Assets, BrokerDirectory, DriverProfile, BookkeeperProfile, RateCon, SettlementReport, settlementMath.js, main.jsx, index.css, index.html, vite.config.js). One-shot git mirror at the Mac; these call the worker, no tenant changes needed.
4. **Wire frontend auth:** store the login token; send `Authorization: Bearer <token>` on every API call; handle 401 → re-login.
5. Later: white-label config layer for new clients; client-storage sovereignty tier.

## DO-NOT / GUARDRAILS
- No deploy and no live-DB migration until at the Mac, with a same-day backup (Cloudflare redundancy != protection against our own bad command).
- Never request tokens/keys/secrets in chat. Secrets live in Cloudflare.
- Keep `account_id`/`database_id` out of committed config (env/dashboard instead).
- Branch protection on `main` is the intended discipline; rely on the CI gate to enforce the wall.
