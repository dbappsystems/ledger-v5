# CLAUDE.md — Load Ledger V5 Operating Brief

**Read this file and docs/AI-MAP.md before touching anything. Do not crawl the repo to rediscover structure.**

---

## 0. WHAT THIS IS

Load Ledger V5 is a **white-label, multi-tenant trucking settlement SaaS** at
loadledgers.com. It bills brokers, pays drivers, tracks fuel/IFTA, and produces
year-end tax reports. The north star: **year-end tax prep is just gathering
reports** — the accounting must already be correct.

This is a **live production app with real money in it.** Every change ships to
production. Never destroy the working app. Never "just try something."

**Owner:** Daddyboy (Tim) · dbappsystems.com
**Build device:** iPhone 14 + Chrome only. Never suggest Mac/desktop/Safari/Windows/keyboard workflows.

---

## 1. STACK (HARD LOCK — do not propose alternatives)

- **Cloudflare only:** Workers + Pages + D1 + R2 + KV + GitHub
- **BANNED:** Netlify, Supabase, AWS, Oracle, PC*Miler
- **Routing:** ORS `driving-hgv` (primary) + OSRM (fallback)
- **Long-term:** client-side storage (iCloud or similar)

| Thing | Value |
|---|---|
| Repo | `github.com/dbappsystems/ledger-v5` · branch `main` |
| Front end | React + Vite SPA in `src/` |
| API | `worker/index.js` (~99KB) → `https://ledger-v5.d49rwgmpj9.workers.dev` |
| DB | D1 `load-ledger-v5-db` · `22bda25f-1827-49fb-84bf-5108b6dac114` · 28 tables |
| Files | R2 `load-ledger-v5-files` (`env.R2`) + legacy `load-ledger-files` (`env.R2_V4`) |
| Rate limit | KV `ledger-v5-ratelimit` (`env.RL_KV`) |
| Deploy | Cloudflare Pages auto-deploys on push to `main` |
| Active tenant | `ten_edgerton` (Edgerton Truck & Trailer Repair) |

---

## 2. THE MATH — SINGLE SOURCE OF TRUTH

**File: `src/settlementMath.js`. Never recompute settlement figures anywhere else.**
If you need a number, import it from here. If a component does its own arithmetic
on money, that is a bug.

### 2.1 The owner cut

```js
DEFAULT_OWNER_CUT = 0.10   // FALLBACK ONLY. Do NOT change to 0.15.
```

The real cut comes from the **tenant setting** (`driver_split_pct`), passed in as
`ownerCutPct`. `normalizeOwnerCut()` accepts `0.15` or `15`, clamps to 1%–50%.
Edgerton runs 15%. The `0.10` in code is a safety fallback and is deliberately
left alone — do not "fix" it.

**Why 0.10 and not 0.15:** the default fires ONLY when a caller forgets to pass
`ownerCutPct`. Set it to 0.15 and that bug produces the correct number for
Edgerton and silently the WRONG number for every future tenant on a different
split. Leaving it at 0.10 guarantees a missing tenant setting shows up as a
visible discrepancy the golden test catches. The 0.10 is deliberately wrong for
every tenant. That is the feature.

### 2.2 Per-load driver pay — `calcPay(load, ownerCutPct)`

```
gross     = base_pay
ownerCut  = base_pay × cut
driverNet = base_pay × (1 − cut) + detention
```

**PERMANENT RULE (Daddyboy Rule):** the carrier cut applies to **every driver on
every load**. There is NO owner-operator exemption. The `is_owner_operator`
branch was removed and the column does not exist on `loads` (verified live).
Never reintroduce it. No flag anywhere may zero out the carrier's cut.

**Detention is 100% driver money** — added on top of the split, never cut.

### 2.3 The two advance types — KEEP THEM STRICTLY SEPARATE

| | **Broker Advance (Comdata)** | **Carrier Advance** |
|---|---|---|
| Direction | broker → driver | carrier → driver (a loan) |
| Lives in | the load itself (`comdatas` / `comdata_total`) | `carrier_advances` table |
| Purpose | offsets lumpers/incidentals on the invoice | breakdown / repair / fuel / general cash need |
| Formula | `advanceKept()` = `max(0, comdata − lumpers − incidentals)` | `carrierAdvanceOwed()` = sum of **unrepaid** rows |
| Effect | leftover reduces the driver's settlement | reduces the driver's settlement until repaid |
| UI label | **"Broker Advance (Comdata)"** | "Carrier Advance" |

"Repair advance" is **not a third concept** — it is a `carrier_advances` row with
`reason = 'repair'`.

`reimbursementOwed()` = `max(0, (lumpers + incidentals) − comdata)` — the carrier
owes the driver back. **Lumper reimbursement is 100% driver money, never cut.**

### 2.4 Recurring charges — weekly only

`recurringChargesForWeek(charges, driverName, weekPayDate)`

- `cadence: 'weekly'` → amount as-is
- `cadence: 'monthly'` → `amount × 12 / 52` (a $1,200/mo insurance line shows
  ~$276.92/week — **never dump a whole month into one week**; that is the
  Non-Exploitation principle in code)
- Applies only if `active` and the week's **pay date** falls inside
  `start_date`…`end_date` (blank = open-ended)

**Recurring charges are DELIBERATELY EXCLUDED from `computeRunningBalance`.**
They are per-week paystub deductions, not part of the all-time balance. Folding
them in would double-count. Do not "fix" this.

### 2.5 THE ANCHOR — `computeRunningBalance({...})`

All-time running balance. **Not period-filtered. Never resets.** A load's
accounting date is its **delivery date** (`loadDate()`).

```
stillOwedRaw = allGrossPay              (Σ calcPay().driverNet)
             − allAdvKept               (Σ advanceKept())
             + allReimb                 (Σ reimbursementOwed())
             − allFleetFuel             (fuel_entries where fuel_type='fleet')
             − allAchDisbursed          (loads where ach_payment → ach_received)
             − allEscrow                (escrow_payments total)
             − allCarrierAdvance        (unrepaid carrier_advances)
             − allSettlementPayments    (settlement_payments cash/check)

stillOwed = max(0, stillOwedRaw)
```

Everything on this list is money **already in the driver's hands**, so it
subtracts. Reimbursement is the only add.

### 2.6 FIFO reconciliation — `src/settlementFifo.js`

Pure, side-effect-free. Walks the driver's loads **oldest delivery date first**
and applies each disbursement dollar to the oldest still-owing load, rolling the
remainder forward.

- **Only two disbursement sources pay down loads:** `settlement_payments`
  (cash/check) and `carrier_advances` where `reason === 'general'` and not repaid.
- **Excluded from FIFO paydown:** repair advances, escrow payments, comdata/broker
  advances (already handled inside the load's own math).
- Per-load value = `driverNet` only. Fuel/escrow/broker are **not** re-subtracted
  per load — they belong to the all-time balance. Re-subtracting them is
  double-counting.
- **Date sorting uses `parseAppDate()`, never raw string sort.** Live data mixes
  `4/7/2026`, `05/21/2026`, `2026-03-16`. String sort puts `05/21` before `4/7`
  and silently misapplies money. `created_at` is the tiebreaker. Unparseable
  dates sink to the end so a bad date never eats the front of the queue.
- All money rounds to cents via `round2()` at every step to stop float drift
  across a long cascade.

### 2.7 `parseAppDate()` — read this before writing any date logic

Parses to **local noon**, not UTC midnight. This is deliberate: UTC midnight rolls
the date back a day in Central time and shifts a load into the wrong week. Handles
both `YYYY-MM-DD` and `M/D/YYYY`. Use it. Never `new Date(str)`.

### 2.8 `asArray()`

`loads.lumpers`, `.incidentals`, `.comdatas` are D1 **TEXT columns holding JSON
strings**, default `'[]'`. Sometimes null, sometimes `''`. `asArray()` never
throws. Always go through it.

### 2.9 The golden test — PERMANENT LAW

`tests/settlement.golden.test.js`. Identities that must hold to the penny:

1. `computeRunningBalance` agrees with `buildFifoLedger`
2. Both agree with a raw hand-rebuild
3. `FIFO credits − debits = stillOwed`

If any identity fails, it fails loudly. **Never edit the fixture to make a test
pass.** The fixture changes only when live data is intentionally corrected.
Doctrine: `docs/LAW-SETTLEMENT-INTEGRITY.md`.

---

## 3. ORDER OF OPERATIONS — where things break if you get it wrong

### 3.1 Load lifecycle

```
Rate con PDF uploaded → /api/ratecon-pdf → R2 → OCR (/api/ocr)
  → rate_confirmations row → RateConQueue.jsx (human confirms)
  → loads row (base_pay, driver UPPERCASE, delivery_date)
  → BOL uploaded (Sauvola binarization, multi-page expand)
  → invoice generated (billing side: base + lumper + incidental − comdata)
  → broker pays (ach_payment / ach_received)
  → settlement side: calcPay → computeRunningBalance
  → carrier pays driver (settlement_payments) → FIFO reconciles oldest-first
```

**Billing side and settlement side are different numbers.** The invoice to the
broker is not the driver's pay. Comdata nets against lumpers on the **invoice**;
its leftover hits the **settlement**. Confusing these is the single most likely
way to corrupt this app.

### 3.2 Request order in the Worker

```
request → CORS check (locked to loadledgers.com + *.pages.dev)
        → public routes only: /api/auth/login, /api/auth/logout, /api/apply
        → everything else: requireTenant()
             → session token (32 bytes, 12h TTL, server-enforced)
             → tenant_id pulled from SESSION CONTEXT — never from client body
        → sub-handlers that return early and own their paths:
             worker/ratecons.js · worker/payments.js · worker/signed.js
        → main route table in worker/index.js
        → safeError() wraps failures (no raw e.message leaks)
```

**`tenant_id` NEVER comes from the request body.** It comes from the session. This
is the entire multi-tenant security model. Any code path that reads `tenant_id`
from client input is an IDOR and must be rejected in review.
CI enforces this: `.github/workflows/tenant-wall.yml` runs
`tests/test_tenant_isolation_static.mjs`.

### 3.3 Why things come back blank

Ranked by how often it actually happens:

1. **Date-range D1 queries.** `created_at` is a **UTC ISO string**. `WHERE created_at >= '2026-07-08'` misses rows written after midnight UTC. **Use `ORDER BY created_at DESC LIMIT N`** for "recent," not date filters.
2. **Driver-name casing.** `loads.driver` is **UPPERCASE** (`'TIM'`, `'BRUCE'`). `computeRunningBalance` filters `l.driver === dn` (exact), but fuel filters `f.driver === dn.toUpperCase()`. Pass the driver name already uppercased or you get an empty, silently-zero result.
3. **Mixed date formats.** `ifta_miles.entry_date` = `MM/DD/YYYY`. `fuel_entries.entry_date` = `YYYY-MM-DD`. `loads.delivery_date` = **both**. Always `parseAppDate()`.
4. **Multi-statement SQL.** D1 rejects multiple `ALTER TABLE` / stacked statements in one call. One statement per call.
5. **Unverified columns.** Run `PRAGMA table_info(table)` before querying or mutating a column you have not personally confirmed.

---

## 4. SECURITY — CURRENT STATE (do not re-audit these as broken)

**Shipped and working:**
- Tenant isolation from session context; IDOR closed
- 32-byte session tokens, 12h server-enforced TTL
- Parameterized queries throughout
- PBKDF2-SHA256 password hashing, self-healing re-hash on login
- `safeError()` — ~69 leaky `e.message` returns genericized
- CORS locked to `https://loadledgers.com` + `*.pages.dev`
- Login rate limiting via KV: 8 fails / 15 min per IP+email → 429; fail-open; clears on success
- A-grade headers in `public/_headers`: HSTS preload, allow-listed CSP, X-Frame-Options DENY, nosniff, Permissions-Policy

### THE PBKDF2 LANDMINE — memorize this

**Cloudflare Workers hard-caps PBKDF2 at exactly 100,000 iterations.** Anything
above throws `NotSupportedError` and **breaks every login on the platform.**

```js
PBKDF2_ITERATIONS = 100000   // MUST be exactly this. Not 600000. Not 200000.
```

**Node tests pass above the cap. Only the deployed Worker enforces it.** If you
"harden" this to the OWASP 600k recommendation because Node accepted it, you take
the entire product down. Test all `crypto.subtle` code against `wrangler dev` or
the deployed Worker — **never against Node alone.**

### Open security gaps (known, pre-launch)
1. **No self-serve password reset.** Manual D1 hash reset required today. Build pending ZeptoMail domain verification + `ZEPTOMAIL_TOKEN` Worker secret.
2. PBKDF2 100k is below OWASP 600k — platform ceiling, accepted limitation.
3. Legal doc gaps: breach-notification window (DPA), data retention/deletion, sub-processor disclosure (Cloudflare + Anthropic OCR API receives tenant BOL/ratecon/receipt docs), PII inventory. Terms must state Daddyboy is a **processor**, not a party to tenant financial data.
4. Worker API origin lacks HSTS/nosniff (Pages has them). Option B: put the Worker behind `api.loadledgers.com` for edge WAF/DDoS.
5. `?t=` session-token-in-URL still present in `DriverProfile.jsx`, `RateCon.jsx`, `Maintenance.jsx`. Convert to header auth, then remove the fallback.
6. 2FA not yet verified on the GitHub and Cloudflare accounts.
7. No backup/restore testing, no audit logging, no incident-response plan.

**NEVER request or accept a token, API key, password, or secret in chat. Absolute.**

---

## 5. PUSH DISCIPLINE — violating this has already broken the repo once

- **Never rewrite `worker/index.js` whole.** A ~90KB single-push rewrite aborted
  mid-write in the past. **Targeted `str_replace` region edits only.**
- **One file per push.** Short commit messages.
- **Files >= ~35KB (esp. JSX):** use `push_files` (git tree API — atomic).
  `create_or_update_file` risks **silent truncation** above ~50KB.
- **Small files:** `create_or_update_file` with a **fresh blob SHA** fetched
  immediately before the push.
- **Pre-push workflow (mandatory):**
  1. Fetch fresh blob SHA (`ref: refs/heads/main`)
  2. Apply edit with a uniqueness guard (`assert src.count(anchor) == 1`)
  3. Validate: JSX → `@babel/parser` (`sourceType:'module'`, `plugins:['jsx']`); JS → `node --check`
  4. Compute expected blob SHA: `sha1(b'blob %d\x00' % len(d) + d)`
  5. Push
  6. **Fetch back at the new commit SHA and verify the blob SHA matches.**
     **Never trust the push receipt alone.**
- `.github/workflows/` writes **403** via GitHub MCP (App lacks `workflows` scope)
  → use the Chrome web editor at
  `github.com/dbappsystems/ledger-v5/edit/main/.github/workflows/<file>`
- Raw fetch: `raw.githubusercontent.com/dbappsystems/ledger-v5/<COMMIT_SHA>/<path>`.
  A raw **404 = stale SHA**, not a permissions wall. Get a fresh SHA from a
  directory listing.

---

## 6. REPO READ DISCIPLINE

1. `docs/AI-MAP.md` + this file **first, always.** Do not list directories.
2. `worker/index.js` (~99KB): **never fetch whole.** Grep the raw URL for the
   route, read only the matching line range. Same for any file > 20KB.
   Files under ~15KB may be read whole.
3. Static public pages live in `public/` (apply, contact, privacy, terms, dpa).
   **Grepping `src/` alone will make you wrongly conclude they don't exist.**
4. Answer the question asked. Two targeted greps beat ten. State the finding plus
   `file:line`.

---

## 7. D1 SAFETY RULES

- `PRAGMA table_info(tablename)` **before** querying or mutating an unverified column.
- Scope every DELETE/UPDATE with `tenant_id` **+** the specific record `id` **+**
  at least one additional field. Three-key minimum.
- One SQL statement per call.
- `created_at` is UTC ISO — use `ORDER BY created_at DESC LIMIT N`, not date filters.

**Fuel ledger rule (locked):** Tim uses an Edgerton fuel card issued by Bruce
(carrier "BRUCE EDGERTON," card 00103). All uploaded fuel Transaction Reports are
**Tim's** and reconcile into **Tim's ledger only**. Never mix Bruce's fuel into
Tim's report or vice versa.

---

## 8. ASSESSMENT

### Strengths
- **The math is centralized and defended.** One module, one anchor function, a
  golden test that fails loudly. This is the single best thing about the codebase
  and the reason it can be trusted with money.
- **Tenant isolation is architecturally sound**, not bolted on — `tenant_id` from
  session context, enforced by CI, not by discipline alone.
- **The comments in `settlementMath.js` and `settlementFifo.js` are load-bearing.**
  They explain *why* (the mixed-date-format trap, the recurring-charge exclusion,
  the local-noon parse). Do not strip them.
- Failure modes are documented rather than rediscovered: the PBKDF2 cap, the UTC
  timestamp gotcha, the push-truncation limit.
- Security posture is genuinely good for pre-launch: CORS locked, rate limiting
  live, errors genericized, A-grade headers.
- Cloudflare-only means one bill, one control plane, one set of failure modes.

### Weaknesses
- **`worker/index.js` at ~99KB is the biggest structural risk.** It is too large
  to safely rewrite, which means it can only be edited surgically forever. Route
  line numbers in AI-MAP.md go stale on every commit. Three sub-handlers already
  split off — the pattern exists but was never finished.
- **No self-serve password reset.** Manual D1 hash surgery is not a launch-grade
  answer for a paying tenant.
- **PBKDF2 capped at 100k** — a real, unfixable-on-platform weakness. Compensate
  with rate limiting (done) and eventual 2FA.
- **Data-format inconsistency is the app's original sin.** Three different date
  formats across three tables, JSON-in-TEXT columns, UPPERCASE driver names as a
  join key. All handled, none fixed. Every new feature has to re-navigate it.
- **No audit log.** For a financial system, "who changed this load's base_pay and
  when" currently has no answer.
- **No backup/restore test.** D1 has snapshots; nobody has proven a restore works.
- Redundancy: `ScheduleCReport.jsx` duplicates what `Tax.jsx` already does. Three
  IFTA modules (`ifta.js`, `ifta_manual.js`, `ifta-manual.js`) — that naming is a
  bug waiting to happen.
- `?t=` session tokens in URLs still live in three components. Tokens in URLs land
  in browser history, logs, and referrers.
- **No live public signup page.** `POST /api/apply` exists and `signup_requests`
  exists, but the front end never calls it — the table stays empty by design gap,
  not by absence of traffic.

### Recommendations — in build order

1. **Ship the password reset flow.** Highest-value open item. Table
   `password_resets` (hashed one-time token, `expires_at`, `used`);
   `POST /api/auth/forgot` (enumeration-safe — identical response whether the
   email exists or not); `POST /api/auth/reset` (validate token, write a new
   **100k** PBKDF2 hash, invalidate all sessions). "Forgot password?" link on the
   **login screen only** — no new buttons inside the authenticated shell.
   60-minute expiry, single-use, "if you didn't request this, ignore" line.
   Blocked on: ZeptoMail domain verification + `ZEPTOMAIL_TOKEN` Worker secret.
2. **Add an append-only audit log table.** `who / what / old value / new value /
   when / tenant_id`, written on every mutation to `loads`, `carrier_advances`,
   `settlement_payments`, `recurring_charges`. This is table stakes for a
   financial system and it gets harder to retrofit every week.
3. **Finish decomposing `worker/index.js`.** The `ratecons.js` / `payments.js` /
   `signed.js` pattern already works. Move loads, fuel, and IFTA out the same way,
   one module per push. This is the change that makes every future change safe.
4. **Prove a D1 restore.** Snapshot, restore to a scratch DB, run the golden test
   against it. Until that passes, there is no backup — only a snapshot.
5. **Kill the `?t=` URL tokens** in `DriverProfile.jsx`, `RateCon.jsx`,
   `Maintenance.jsx`, then delete the fallback path.
6. **Wire the public signup page** to the existing `POST /api/apply`. The API is
   already built; only the front-end route is missing.
7. **Close the legal-doc gaps** — breach-notification window, retention/deletion
   policy, sub-processor disclosure (Cloudflare + Anthropic OCR receive tenant
   documents), PII inventory, processor-not-party language in the Terms.
   These carry real exposure and cost nothing but time.
8. **Then** `api.loadledgers.com` for the Worker (edge WAF), 2FA on GitHub +
   Cloudflare, and the `load_stops` multi-stop mileage build (schema is designed).

---

## 9. THE RULES THAT DO NOT BEND

1. **Never destroy the working live app.** Every change ships to production.
2. **Never recompute settlement math outside `src/settlementMath.js`.**
3. **`PBKDF2_ITERATIONS` is exactly `100000`.** Node passing != Workers passing.
4. **`DEFAULT_OWNER_CUT = 0.10` stays `0.10`.** It is a fallback, not the rate.
5. **The carrier cut applies to every driver on every load.** No exemption, ever.
6. **Detention and lumper reimbursement are 100% driver money.** Never cut.
7. **`tenant_id` comes from the session, never from the client.**
8. **Never edit `tests/settlement.golden.test.js` to make a failure go away.**
9. **Never rewrite `worker/index.js` whole.** Targeted edits only.
10. **Never request a secret in chat.**
11. Flag anything unverified as **"verify this."** Never state an assumption as fact.
12. When a **legal concern** arises on a new build, critique against the **Beards
    Doctrine**: Transparency of Intent · Non-Exploitation · Sovereignty of the
    User · Accountability Without Exception · Truth as Architecture.
