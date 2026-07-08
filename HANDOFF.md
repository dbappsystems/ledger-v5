# Load Ledger V5 — Build Handoff
**(c) dbappsystems.com **
**Last updated: 2026-06-17 (rev 4)**

> Paste this at the start of a new chat to continue the build without re-deriving decisions.
> VERIFY against the live repo before trusting — this doc can drift. Treat the repo as truth.

---

## TOP PRIORITY (start here next session)
**Loads.jsx leaderboard de-hardcoding** — the last real white-label hardcode.
`src/Loads.jsx` still bakes in a TWO-DRIVER BRUCE/TIM model:
- the `['all','BRUCE','TIM']` filter tabs,
- the all-time **leaderboard** (`bruceLoads`/`timLoads`, totals, crowns, winning banner),
- per-driver **card colors** (the `load.driver==='BRUCE' ? blue : red` ternaries and the navy/maroon header backgrounds),
- a **TIM-only ACH rule** (`load.driver === 'TIM'` gates the ⚡ ACH button).
These must be driven by the tenant's OWN driver list via `useDrivers()` (arbitrary length, not two fixed names). This is the heaviest remaining item — it restructures UI around an N-driver list. Money math is NOT involved; do not touch settlement numbers. Use `colorFor(name)` for colors and `names`/`drivers` for the tabs+leaderboard. Decide with the user how the ACH rule should generalize (likely a per-driver or per-tenant flag, NOT a name check) before coding — that's the one open design question.

---

## OPERATING DISCIPLINE (how to work in this build — enforced by the user)
- **iPhone only.** Builds on phone → GitHub → Cloudflare. Mac is never in the deploy path. Chrome only (never Safari). Call the user **Daddyboy**.
- **Truth AI + Beards Doctrine** govern everything. Beards 5: Transparency of Intent, Non-Exploitation, Sovereignty of the User, Accountability Without Exception, Truth as Architecture. Flag uncertain facts as "verify this"; never present an assumption as fact.
- **Do NOT re-dump completed work to chat** — it wastes the user's credits. Work in sections; save to on-disk checkpoints in `/home/claude/audit/`. Once saved/verified it's done — don't reconstruct or re-paste it. The ONLY unavoidable exception is the GitHub push tools, which require full file content inline.
- **Don't over-ask.** Execute first; do standard trucking-industry accounting and make the right call that keeps the build on track while preserving security/stability/integrity. Use the elicitation tool ONLY for genuine A/B/C forks — and ALWAYS for changes to tax numbers / money behavior (never guess on those).
- **Stack is locked: Cloudflare Workers + Pages + D1 + R2 + GitHub ONLY.** Do NOT touch Supabase/Netlify/AWS tools even if they appear in the tool list — not our stack, and there is no live DB during the build. Do NOT switch to PR/branch workflows unless the user asks; work goes straight to `main`.

## THE PROVEN COMMIT WORKFLOW (follow exactly — this is what keeps integrity)
This workflow exists because a bundled multi-file push got TRUNCATED earlier and left a half-finished task. The fix:
1. **Fetch the ACTUAL current file** via the GitHub `get_file_contents` tool (plain curl on raw.githubusercontent 404s for this private repo). Note the blob SHA it returns.
2. **Write it to `/home/claude/audit/<file>` and confirm `git hash-object <file>` equals that blob SHA** BEFORE editing. This is the ground-truth gate — never edit a file whose hash you haven't matched to the repo.
3. **Make small, surgical `str_replace` edits.** For JSX, validate with babel; the babel install resets each turn, so run install+check in ONE command:
   `cd /tmp/babelcheck && npm install @babel/core @babel/preset-react >/dev/null 2>&1; node check.cjs <file>` → expect `BABEL PARSE OK`. For the worker/plain JS, `node --check <file>`.
   (Note: chaining independent greps with `&&` aborts when a `grep -c` returns 0; use `;` separators.)
4. **Push ONE file per commit** via `create_or_update_file` with the base SHA. NEVER bundle large files in a single `push_files` — that is the call that truncated.
5. **After every push, verify the returned blob SHA equals local `git hash-object`** before calling it done. If it doesn't match, stop and investigate — do not proceed.

---

## WHO / WHAT
- **Owner:** Daddyboy. Builds on **iPhone only**.
- **App:** the **dbappsystems app** (Load Ledger). NOT "the Bruce app." Bruce is a **client**; Daddyboy also drives for the company, so both have logins.
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
2. **Retention = continuous value, not lock-in.** Long-term vision: client-owned storage (iCloud-style) as a premium sovereignty tier.
3. **The wall is enforced in code, every query** — `tenant_id` comes from the session token, NEVER from the request body/URL.
4. **v5 uses a NEW, SEPARATE database** (`load-ledger-v5-db`). The live v4 DB is never touched during the build.
5. **Per-tenant owner split.** v4's hardcoded cut became `driver_split_pct` (default 10 = identical to v4). Owner-operators keep 100% via `load.is_owner_operator`.
6. **Two-advance accounting model (industry standard, kept separate):**
   - **Broker Advance (Comdata):** broker→driver, billing-side. Nets against lumpers/incidentals on the invoice; any leftover (advance kept) reduces that driver's settlement.
   - **Carrier Advance:** carrier→driver direct loan (breakdown/repair/fuel/general), repaid out of settlement, with a `reason` field. "Repair advance" is just `reason='repair'`, not its own concept.
7. **Drivers are first-class, not string-matched.** A per-tenant `drivers` table (real IDs + `is_owner_operator` flag + `color` + per-driver `state_label`/`state_rate`) replaces BRUCE/TIM string matching. The shared `useDrivers()` hook is the single source of a tenant's drivers across the frontend.
8. **Per-driver state tax default:** when a driver has no state rate set, Tax.jsx falls back to the **tenant owner-operator's** state (the driver flagged `is_owner_operator` with a rate set) — never to another client's hardcoded rate.
9. **Client PII does not live in source.** Each tenant's invoice identity (company name, address, MC/DOT, contact) lives in its own tenant row; code carries neutral/blank fallbacks only.

---

## DONE (verified on `main`)

### Backend / DB — migrations
- `migrations/0001_add_tenancy.sql` — `tenants` + `sessions`; `tenant_id` on all 9 data tables; backfills legacy rows into a default tenant; per-tenant indexes + uniqueness; adds `salt`.
- `migrations/0002_tenant_settings.sql` — adds `driver_split_pct` (default 10) AND the white-label invoice-identity columns; **seeds Bruce's real remit_address / mc_number / contact line into his tenant row** (so the PII fallbacks could be removed from code with no change to the live invoice).
- `migrations/0003_drivers_and_carrier_advances.sql` — two per-tenant tables:
  - `drivers` {id, tenant_id, name (UPPERCASE), display_name, is_owner_operator 0/1, color, **state_label, state_rate**, active}; unique (tenant_id, name).
  - `carrier_advances` {id, tenant_id, driver, amount, advance_date, reason ('general' default), notes, asset_id, repaid 0/1, repaid_date}.
  - Seeds default tenant: BRUCE (owner_op=1, #1e88e5, Wisconsin 0.0530) + TIM (owner_op=0, #e53935, Illinois 0.0495) — matches the retired hardcoded values exactly.
  - A "LATER" section (driver_id FK columns + backfill) is intentionally deferred to cutover day — NOT part of current work.

### Backend — worker
- `worker/index.js` — every route tenant-scoped; session-token auth via `requireTenant()` (Authorization header primary; `?t=` query accepted on GET only, for browser file links). Routes include loads, invoice PDF (R2), credentials, maintenance, escrow, assets+payments, fuel, brokers, `/api/tenant/settings`, `/api/drivers` (GET/POST/PATCH/DELETE — **now accepts/returns state_label + state_rate**), `/api/carrier-advance(s)`.
- Security: SHA-256+salt passwords (auto-upgrade on login); 12h sessions; R2 namespaced `{tenant_id}/...` and ownership-checked. Roles: 'owner'/'bookkeeper'/'driver'.

### Frontend
- v4 frontend migrated to token auth; every call goes through `api()` (`src/api.js`, Bearer token, session key `ll_v5_session`).
- `src/settlementMath.js` — SINGLE SOURCE OF TRUTH for money math (`calcPay`, `advanceKept`/`brokerAdvanceKept`, `carrierAdvanceOwed`, `computeRunningBalance`). DO NOT change without proving identical numbers.
- `src/useDrivers.js` — shared hook; `GET /api/drivers`, falls back to seeded BRUCE/TIM (now incl. Wisconsin/Illinois state tax) so the live client can't regress. Exposes `drivers`, `names`, `colorFor(name)`, **`taxInfoFor(name)`** (returns {state_label, state_rate}; owner-operator-state fallback), `loading`.

### Step 5 — driver de-hardcoding (COMPLETE)
BRUCE/TIM logic/color hardcoding removed (money math untouched), each consumes `useDrivers()`:
- `src/App.jsx`, `src/BookkeeperProfile.jsx`, `src/SettlementReport.jsx`.
- Intentionally left: escrow stays TIM-specific (Edgerton ETTR financing tracker — client-specific, out of scope).

### This session's work (all single-file commits, SHA-verified on `main`)
- **PII removal (complete):** Bruce's address/MC/contact moved into his 0002 tenant seed; `src/Invoice.jsx` and `src/Loads.jsx` invoice-identity fallbacks neutralized to blank. No client PII remains in source; live invoice unchanged because the tenant row supplies the real values.
- **State-tax de-hardcoding (complete, 4 coordinated pieces):** the old hardcoded `STATE_RATES{TIM,BRUCE}` table in Tax.jsx is GONE.
  1. migration 0003 — added `state_label`/`state_rate` columns + seed.
  2. worker — `/api/drivers` insert/upsert/PATCH handle the two fields (GET already `SELECT *`).
  3. `src/useDrivers.js` — carries the fields through + `taxInfoFor()` with owner-state fallback.
  4. `src/Tax.jsx` — consumes `useDrivers().taxInfoFor(driver)`, reshaped into the existing `{rate,label,default}` object so ALL tax math/display is byte-for-byte unchanged; color via `colorFor(driver)`. Live tenant output identical (BRUCE Wisconsin 5.30% blue, TIM Illinois 4.95% red) — now data-driven.

### Tests + CI
- `tests/test_tenant_isolation_static.mjs` — scans worker source; FAILS if any data query loses `tenant_id` (merge gate). Passing.
- `tests/test_tenant_isolation_live.mjs` — end-to-end; run post-deploy with 2 seeded tenants.
- `.github/workflows/tenant-wall.yml` — runs the static test on every push + PR.

## NOT DONE / NEXT (in priority order)
1. **Loads.jsx leaderboard de-hardcoding** — see TOP PRIORITY above. The last real white-label hardcode.
2. **Cloudflare side (Mac / dashboard, cutover day):**
   - Create `load-ledger-v5-db` (D1) and `load-ledger-v5-files` (R2).
   - Put the new DB id into `worker/wrangler.toml`.
   - Apply migrations 0001 → 0002 → 0003 to the new DB (with a same-day backup).
   - Run 0003's deferred "LATER" data step (driver_id FK + backfill) at cutover.
   - Set `ANTHROPIC_API_KEY` as a Worker secret; set `account_id` via dashboard (kept out of repo).
3. **Run the live isolation test** against the deployed worker (seed 2 tenants first). Must pass before real clients.
4. **Tenant branding pass:** the statement overlay still hardcodes "Edgerton Truck & Trailer Repair" → tenant config. Generalize the TIM-only ETTR escrow tracker if a second client needs financing tracking.
5. **White-label config layer** for onboarding new clients; then the client-storage sovereignty tier.

## SMALL FLAGGED ITEMS (not blockers)
- `src/Tax.jsx` — the escrow/payback block is still fetched only for the literal driver `'TIM'` (Edgerton ETTR tracker). Flagged in-file; out of scope until a second client needs it.
- `src/Loads.jsx` — `WORKER TODO`: `/api/invoice/:id` GET must also accept `?t=<token>` (a plain `<a>` link can't send the Authorization header). The worker's `requireTenant()` already supports `?t=` on GET, so this is wired — confirm at deploy.

## DO-NOT / GUARDRAILS
- No deploy and no live-DB migration until at the Mac, with a same-day backup (Cloudflare redundancy != protection against our own bad command).
- Never request tokens/keys/secrets in chat. Secrets live in Cloudflare.
- Keep `account_id`/`database_id` out of committed config (env/dashboard instead).
- v4 stays frozen. Flag every white-label hardcode as it's found.
- Money logic (`settlementMath.js`) is the source of truth — prove any change produces identical numbers before shipping.
- One file per commit; match the blob SHA before editing and after pushing. Never bundle large files in one push.
