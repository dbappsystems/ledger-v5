# AI-MAP.md — Load Ledger V5 Fast Lookup

**Purpose:** Read this file FIRST on any repo question. It replaces directory
crawling. Every row below is verified against live code + live D1. If a claim
here conflicts with the live file, the live file wins — re-grep and update this.

**Repo:** github.com/dbappsystems/ledger-v5 · branch `main` · org `dbappsystems`
**D1:** `load-ledger-v5-db` · ID `22bda25f-1827-49fb-84bf-5108b6dac114`
**Worker API base:** https://ledger-v5.d49rwgmpj9.workers.dev
**Deploy:** Cloudflare Pages auto-deploys on push to `main`.

---

## HOW TO READ THIS REPO CHEAPLY (assistant contract)

1. Answer from memory + this file first. Do NOT list directories to rediscover
   the structure — the structure is below.
2. `worker/index.js` is ~97KB. NEVER fetch it whole. `grep` the raw URL for the
   route, then read only that line range.
3. For any file >20KB: grep first, read the region, never fetch in full.
4. Load a tool once. Do not re-run tool_search for a tool already loaded.
5. Raw fetch pattern (works with current commit SHA):
   `https://raw.githubusercontent.com/dbappsystems/ledger-v5/<SHA>/<path>`
   404 = stale SHA, not permissions. Get fresh SHA from a directory listing.

---

## AUTHORITATIVE MATH — never re-derive elsewhere

File: `src/settlementMath.js` (~12KB, safe to read whole)

| Concern | Function / const | Note |
|---|---|---|
| Running balance (anchor) | `computeRunningBalance({...})` | THE reconciliation truth. Display + FIFO must match to the penny. |
| Driver pay per load | `calcPay(load, ownerCutPct)` | No owner-op exemption. Commission always applies. |
| Owner cut normalize | `normalizeOwnerCut()` | Accepts 0.15 or 15; clamps 1%–50%. |
| `DEFAULT_OWNER_CUT = 0.10` | fallback ONLY | Real rate comes from tenant settings (15%). Do NOT hardcode 0.15 here. |
| Broker advance leftover | `advanceKept()` / `brokerAdvanceKept` | Comdata minus lumpers/incidentals. |
| Carrier advance owed | `carrierAdvanceOwed()` | carrier→driver loan, repaid from settlement. |
| Recurring charge/week | `recurringChargesForWeek()` | + `recurringChargeAppliesToWeek()`. |

Doctrine: `docs/LAW-SETTLEMENT-INTEGRITY.md` · Golden test: `tests/settlement.golden.test.js`

---

## WORKER ROUTES — worker/index.js (line numbers @ current SHA; re-grep if stale)

Public (pre-tenant): `POST /api/auth/login` · `POST /api/auth/logout` · `POST /api/apply`
Everything below requires tenant (`requireTenant`).

| Route | Method(s) | ~Line |
|---|---|---|
| /api/apply (signup intake → `signup_requests`) | POST | 239 |
| /api/ocr | POST | 282 |
| /api/loads | GET/POST | 328/337 |
| /api/loads/:id | PATCH/DELETE | 853/892 |
| /api/loads/:id/route-ifta | POST | 1666 |
| /api/upload-pdf | POST | 415 |
| /api/ratecon-pdf | POST | 435 |
| /api/maintenance | POST | 620 |
| /api/escrow-payment | POST | 725 |
| /api/assets | POST | 750 |
| /api/fuel | GET(:id)/POST/PATCH/DELETE | 913/923/942/959 |
| /api/fuel/reconcile | POST | 984 |
| /api/fuel-receipt/:id | GET/POST | 1148/1131 |
| /api/brokers | GET/POST | 1170/1179 |
| /api/brokers/:id | PATCH/DELETE + /loads GET | 1242/1259/1216 |
| /api/tenant/settings | GET/PATCH | 1269/1282 |
| /api/drivers | GET/POST | 1311/1320 |
| /api/drivers/:id | PATCH/DELETE | 1361/1382 |
| /api/carrier-advance(s) | GET/POST/PATCH/DELETE | 1393/1403/1426/1452 |
| /api/recurring-charge(s) | GET/POST/PATCH/DELETE | 1468/1478/1504/1529 |
| /api/load-stop(s) | GET/POST/PATCH/DELETE + /geocode | 1547/1559/1585/1622/1633 |
| /api/ifta/manual | POST | 1680 |
| /api/ifta/:id | GET | 1687 |
| /api/contact | POST/GET | 1696/1713 |

Sub-handlers returning early (own their paths): `worker/ratecons.js` (rate cons),
`worker/payments.js` (settlement-payment FIFO), `worker/signed.js` (signed mint).
Other worker modules: `gl.js` (chart of accounts), `ifta.js` (routed IFTA
estimate) + `ifta_manual.js` (driver odometer-chain fact side), `states.js`
(state geometry).

---

## LIVE D1 TABLES (28, verified)

_cf_KV · asset_payments · assets · badges · brokers · carrier_advances ·
contact_messages · driver_credentials · drivers · escrow_payments · expenses ·
fuel_entries · gl_accounts · ifta_miles · ifta_segments · invoices · load_stops ·
loads · maintenance_ledger · rate_confirmations · recurring_charges · sessions ·
settlement_payments · signed_assets · signup_requests · tenants · users
(+ sqlite_sequence)

Key gotchas:
- `loads.driver` is UPPERCASE ('TIM' / 'BRUCE'). Always filter tenant_id + driver
  + one more field.
- `created_at` is UTC ISO. Date-range `>= 'YYYY-MM-DD'` misses post-midnight-UTC
  rows. Use `ORDER BY created_at DESC LIMIT N` for "recent".
- `ifta_miles.entry_date` = MM/DD/YYYY · `fuel_entries.entry_date` = YYYY-MM-DD.
- D1 rejects multi-statement SQL (multiple ALTER / UNION ALL in one call). One
  statement per call.

---

## FRONT-END COMPONENT MAP (src/)

App.jsx (shell/routing) · api.js (fetch helpers) · main.jsx (mount)
Loads.jsx · Invoice.jsx · Maintenance.jsx · SettlementReport.jsx · Tax.jsx
("TIM'S TAX DESK") · DriverPaystub.jsx · DriverProfile.jsx · BookkeeperProfile.jsx
· BrokerDirectory.jsx · RateCon.jsx · RateConQueue.jsx · Assets.jsx · Feedback.jsx
· IftaDailyLog.jsx · IftaEstimate.jsx · IftaReport.jsx · ScheduleCReport.jsx
(redundant — Tax.jsx already does this) · DrilldownOverlay.jsx
Logic: settlementMath.js · settlementFifo.js · settlementDrilldown.js · useDrivers.js

**Signup pipeline (VERIFIED LIVE):** the public signup page is a STATIC page in
`public/`, NOT in `src/`. It is live at `https://loadledgers.com/apply/` (HTTP 200),
plain HTML + vanilla JS, `noindex` (private link). It POSTs to
`ledger-v5.d49rwgmpj9.workers.dev/api/apply` with exact fields the worker expects.
Endpoint verified writing to `signup_requests`. The table is empty only because no
prospect has submitted — the pipeline is intact end to end. Do NOT conclude "no
signup page" from grepping `src/` alone — always check `public/` for static pages.

---

## STATIC PUBLIC PAGES (public/) — served directly by Pages, outside the React app

| Path (live) | File | Purpose |
|---|---|---|
| /apply/ | public/apply/index.html | Prospect signup → POST /api/apply → signup_requests |
| /contact/ | public/contact/ | Contact form |
| /privacy/ | public/privacy/ | Privacy policy |
| /terms/ | public/terms/ | Terms |
| /dpa/ | public/dpa/ | Data processing addendum |
| public/_headers | — | Cloudflare Pages CSP/headers live HERE (not index.html) |

The React app (src/) is separate. Signup, contact, and legal pages do NOT appear
in App.jsx routing — they are static under public/.

---

## PUSH DISCIPLINE (hard rules)

- One file per push. Short commit messages.
- Large JSX (95KB+): `Github:push_files` (tree API) only. Never
  `create_or_update_file` for large files.
- Small files via `create_or_update_file` need a FRESH blob SHA fetched
  immediately before push.
- `.github/workflows/` writes return 403 → use Chrome web editor.
- Post-push: re-fetch the file at the new SHA to confirm. Never trust the receipt.
- Never rewrite `worker/index.js` whole — targeted region edit only.

---

## STACK LOCK

Cloudflare only: Workers + Pages + D1 + R2 + GitHub. No Netlify, Supabase, AWS,
Oracle. Routing: ORS driving-hgv (primary) + OSRM (fallback). PC*Miler BANNED.
Long-term: client-side storage (iCloud or similar).
