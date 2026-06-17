# Load Ledger V5 — Build Handoff
**(c) dbappsystems.com | daddyboyapps.com**
**Last updated: 2026-06-17 (rev 3)**

> Paste this at the start of a new chat to continue the build without re-deriving decisions.
> VERIFY against the live repo before trusting — this doc can drift.

---

## WHO / WHAT
- **Owner:** Daddyboy. Builds on **iPhone only** (Mac days out; phone→GitHub→Cloudflare is the working path; Mac is never in the deploy path).
- **App:** the **dbappsystems app** (Load Ledger). NOT "the Bruce app." Bruce is a **client**; Daddyboy also drives for the company in the app, so both have logins.
- **Goal:** turn the single-operator v4 app into a **multi-tenant SaaS** so ~50 trucking clients each have isolated data (own brokers, loads, payroll, fuel, maintenance, assets, tax) — nobody sees anyone else's.
- **North star for v5:** v4 works but was pieced together by a non-coder. v5 is the stable, white-label, better-structured rebuild with industry-standard accounting so year-end tax prep is just gathering reports.

## REPOS
- **v4 (LIVE, frozen baseline):** `sign-it-now/load-ledger-v4` — React/Vite + Cloudflare Worker + D1 + R2. Serves ettrapp.com for Bruce & Tim. DO NOT disturb.
- **v5 (in progress):** `dbappsystems/ledger-v5`
  - `main` = active branch; holds worker + migrations + frontend + tests + CI. Commit author shows as `sign-it-now`.

## STACK (locked)
Cloudflare Workers + Pages + D1 + R2 + GitHub only. No Netlify/Supabase/AWS/Oracle on new projects.

---

## DECISIONS MADE (don't relitigate)
1. **Multi-tenant SaaS, not per-client deployments.** One codebase, one DB, clients separated by `tenant_id`. Updates ship once to everyone.
2. **Retention = continuous value, not lock-in.** Long-term vision: client-owned storage (iCloud-style) as a premium sovereignty tier (Beards Doctrine: Sovereignty of the User).
3. **The wall is enforced in code, every query** — `tenant_id` comes from the session token, NEVER from the request body/URL.
4. **Branch flow:** protected `main`, feature branches, merge via PR. CI runs the static isolation test as the merge gate.
5. **v5 uses a NEW, SEPARATE database** (`load-ledger-v5-db`). The live v4 DB is never touched during the build.
6. **Per-tenant owner split.** v4's hardcoded BRUCE_CUT/TIM_CUT (0.90) became the `ownerCutPct` prop (default 10 = identical to v4). Owner-operators keep 100% via `load.is_owner_operator`.
7. **Two-advance accounting model (industry standard, kept separate):**
   - **Broker Advance (Comdata):** broker→driver, billing-side. Nets against lumpers/incidentals on the invoice; any leftover (advance kept) reduces that driver's settlement.
   - **Carrier Advance:** carrier→driver direct loan (breakdown/repair/fuel/general), repaid out of settlement, with a `reason` field. "Repair advance" is just `reason='repair'`, not its own concept.
8. **Drivers are first-class, not string-matched.** A per-tenant `drivers` table (real IDs + `is_owner_operator` flag) replaces the old BRUCE/TIM string matching. A shared `useDrivers()` hook is the single source of a tenant's drivers across the frontend.

---

## DONE (verified on `main`)

### Backend / DB
- `migrations/0001_add_tenancy.sql` — `tenants` + `sessions` tables; `tenant_id` on all 9 data tables; backfills legacy rows into a default tenant; per-tenant indexes + uniqueness; adds `salt`.
- `migrations/0002` — adds `driver_split_pct` (REAL, default 10).
- `migrations/0003_drivers_and_carrier_advances.sql` — adds two per-tenant tables:
  - `drivers` {id, tenant_id, name (UPPERCASE), display_name, is_owner_operator 0/1, color, active} with unique index (tenant_id, name).
  - `carrier_advances` {id, tenant_id, driver, amount, advance_date, reason ('general' default), notes, asset_id, repaid 0/1, repaid_date}.
  - Seeds the default tenant with BRUCE (owner_op=1, #1e88e5) and TIM (owner_op=0, #e53935).
  - A "LATER" section (driver_id FK columns + backfill) is intentionally deferred to cutover day — NOT part of the current work.
- `worker/index.js` — every route tenant-scoped; session-token auth via `requireTenant()`. Includes `/api/drivers` (GET/POST/PATCH/DELETE) and `/api/carrier-advance(s)` routes.
- Security hardening: plaintext passwords → SHA-256+salt (auto-upgrade on next login); 12h session tokens; R2 files namespaced `{tenant_id}/...` and ownership-checked.
- Roles generalized to `role` ('owner'/'bookkeeper'/'driver').

### Frontend (now in v5)
- v4 frontend brought into v5 and migrated to token auth: every API call goes through the `api()` client (`src/api.js`, Bearer token, session key `ll_v5_session`).
- `src/settlementMath.js` — single source of truth for money math: `calcPay` (owner-op via `is_owner_operator`), `advanceKept`/`brokerAdvanceKept`, `carrierAdvanceOwed`, `computeRunningBalance` (returns `allCarrierAdvance` + `stillOwed`). DO NOT change without proving numbers identical.
- `src/useDrivers.js` — shared hook; `GET /api/drivers`, falls back to seeded BRUCE/TIM so the live client can't regress. Exposes `names`, `colorFor(name)`, `drivers`, `loading`.
- Carrier-advance UI in SettlementReport (add/list/repaid-toggle/delete; reason chips).

### Step 5 — white-label driver de-hardcoding (COMPLETE)
All BRUCE/TIM string/color hardcoding removed from driver **logic** (money math untouched); each consumes `useDrivers()`:
- `src/App.jsx` — viewing bar maps the tenant's drivers.
- `src/BookkeeperProfile.jsx` — billing report iterates tenant drivers (was fixed bruceStats/timStats).
- `src/SettlementReport.jsx` — driversToShow, per-driver colors, fuel/advance fetches, and the statement header color all come from the tenant's drivers.
- **Intentionally left:** escrow logic stays TIM-specific (the Edgerton ETTR financing tracker, a client-specific concern, out of scope); the statement overlay still hardcodes the company name "Edgerton Truck & Trailer Repair" → becomes tenant branding in a later pass.

### Tests + CI
- `tests/test_tenant_isolation_static.mjs` — scans the worker source; FAILS if any data query loses `tenant_id` (the merge gate). Currently passing.
- `tests/test_tenant_isolation_live.mjs` — end-to-end; run post-deploy with 2 seeded tenants.
- `.github/workflows/tenant-wall.yml` — runs the static test on every push + PR.

## NOT DONE / NEXT (in order)
1. **Cloudflare side (Mac / dashboard, cutover day):**
   - Create `load-ledger-v5-db` (D1) and `load-ledger-v5-files` (R2).
   - Put the new DB id into `worker/wrangler.toml`.
   - Apply migrations 0001 → 0002 → 0003 to that new DB (with a same-day backup).
   - Run migration 0003's deferred "LATER" data step (driver_id FK + backfill) as part of cutover.
   - Set `ANTHROPIC_API_KEY` as a Worker secret; set `account_id` via dashboard (kept out of repo).
2. **Run the live isolation test** against the deployed worker (seed 2 tenants first). Must pass before real clients.
3. **Tenant branding pass:** company name "Edgerton Truck & Trailer Repair" in the statement overlay → tenant config. Generalize the TIM-specific ETTR escrow tracker if a second client needs financing tracking.
4. **White-label config layer** for onboarding new clients; then the client-storage sovereignty tier.

## DO-NOT / GUARDRAILS
- No deploy and no live-DB migration until at the Mac, with a same-day backup (Cloudflare redundancy != protection against our own bad command).
- Never request tokens/keys/secrets in chat. Secrets live in Cloudflare.
- Keep `account_id`/`database_id` out of committed config (env/dashboard instead).
- v4 stays frozen. Flag every white-label hardcode as it's found.
- Money logic (`settlementMath.js`) is the source of truth — prove any change produces identical numbers before shipping.
- Branch protection on `main` + the CI gate enforce the tenant wall.
