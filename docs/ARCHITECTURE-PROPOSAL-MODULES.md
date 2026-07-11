# PROPOSAL — Unbreakable Module Blocks + Hash-Chained Ledger

**Status: PROPOSAL / discussion draft. Ships nothing. Changes no app logic.**
**Read `CLAUDE.md` + `docs/AI-MAP.md` first. This document defers to both; where
it conflicts with live code, the live code wins.**

This is a reaction target for the question: *"Should this be broken into modules
that connect with a hash to isolate each block — the way accounting / carrier
apps are customarily architected?"* Short answer: **yes, and your instinct maps
onto two real, standard techniques.** This spells out what they are, how they fit
Load Ledger V5 specifically, and the order to do them in without ever risking the
live app.

---

## 0. THE TWO IDEAS, DECODED

You described one thing; it's actually two standard techniques that belong together.

| You said | The real technique | Where it lives |
|---|---|---|
| "Unbreakable module blocks" | **Domain modules with a small fixed public interface + a contract test at the boundary** | the *code* layer |
| "Connect with a hash to isolate" | **Append-only, hash-chained audit ledger** (tamper-evident records) | the *data* layer |

A hash does **not** wire modules together — but it is exactly how a financial
system makes its records tamper-evident, which is the "unbreakable" property you
want where it actually matters: the money history. So we do both, at the two
different layers.

You already own the single best example of an unbreakable block in the repo:
`settlementMath.js` + `tests/settlement.golden.test.js`. One door in, one
authoritative answer out, a test that fails loudly if the math moves a penny.
**The whole plan is: make the rest of the app look like that one module.**

---

## 1. WHAT IS ACTUALLY CUSTOMARY (financial / carrier apps)

Four load-bearing principles. Two you already do well.

| # | Principle | Plain meaning | LLV5 today |
|---|---|---|---|
| 1 | **Immutable / append-only ledger** | Money rows are never edited or deleted. A correction is a *new reversing entry*. History is the truth. | ⚠️ **The gap.** `loads`, `carrier_advances`, etc. are mutated in place (`PATCH`/`DELETE` routes). No record of "who changed base_pay from X to Y." |
| 2 | **One system of record; reports derive** | The ledger is authoritative; every screen/report is a *view computed from it*, never its own source. | ✅ **Done well.** `settlementMath.js` is the source; reports read it (this is the Settlement Integrity Law). |
| 3 | **Bounded domain modules** | loads · settlement · fuel/IFTA · invoicing · advances · auth/tenancy — each a block with one clear door. | ⚠️ **Partial.** `settlementMath`/`settlementFifo` are clean blocks; `ratecons/payments/signed` split off. `worker/index.js` (~107KB) is still a monolith. |
| 4 | **Integrity checks at the seams** | Idempotency keys, checksums, tamper-evidence on the record of record. | ⚠️ Only at the golden-test layer, not in the running data. |

Principles **1** and **4** are your "hash to isolate" instinct. They are the
customary financial pattern and they are LLV5's two weakest spots. Principle **3**
is your "module blocks" instinct and is already `CLAUDE.md` Recommendation #3.

**Right-sizing note (important):** "customary for a big accounting firm" means
double-entry general ledgers, event sourcing, microservices. **LLV5 does not need
that** — one live tenant, built on an iPhone, pre-launch. The correct, in-scope
version is: *incremental module extraction + an append-only hash-chained audit log
on the money tables.* Same principles, appropriately small. Over-architecting a
working live app is itself a way to break Rule #1.

---

## 2. LAYER A — UNBREAKABLE MODULE BLOCKS (code)

### 2.1 What makes a block "unbreakable"

Not a hash. Three properties:

1. **A small, fixed public interface** — the module exposes ~4–6 functions/routes;
   everything else is private and free to change.
2. **A contract test at the boundary** — a golden-style test that pins the
   module's observable output. Change the internals all you want; if the *output*
   drifts, CI goes red. This is the `settlement.golden.test.js` pattern, applied
   per module.
3. **No cross-module reach-in** — modules talk through their door, never by
   grabbing each other's internals. `tenant_id` always from session context
   (existing security model, unchanged).

### 2.2 Target module map (Worker)

Grounded in the real route table in `AI-MAP.md`. Each row becomes one file behind
`worker/index.js`, following the **existing, proven** `ratecons.js` / `payments.js`
/ `signed.js` split pattern (early-return sub-handlers that own their paths).

| Module (proposed file) | Owns these routes | Notes |
|---|---|---|
| `worker/auth.js` | `/api/auth/login`, `/logout`, session/tenant guard | The PBKDF2 **100000** landmine lives here — carries a loud comment. |
| `worker/loads.js` | `/api/loads*`, `/api/loads/:id*` | Biggest. Extract last, most carefully. |
| `worker/fuel.js` | `/api/fuel*`, `/api/fuel/reconcile`, `/api/fuel-receipt/*` | Bruce-vs-Tim fuel wall (D1 rule) stays intact. |
| `worker/ifta.js` *(exists)* | `/api/ifta/*`, `/api/loads/:id/route-ifta` | Already separate; formalize its door. |
| `worker/advances.js` | `/api/carrier-advance(s)*` | Repair-fund thread. Pairs with settlement. |
| `worker/settlement.js` | settlement-payment routes | Reads `src/settlementMath.js` truth; never re-derives. |
| `worker/brokers.js` | `/api/brokers*`, `/api/tenant/settings` | |
| `worker/drivers.js` | `/api/drivers*` | |
| `worker/assets.js` | `/api/assets*`, `/api/maintenance*`, credentials | |
| `worker/stops.js` | `/api/load-stop(s)*`, `/geocode` | Multi-stop mileage lives here. |
| `worker/ratecons.js` · `payments.js` · `signed.js` *(exist)* | rate-con / payment / signed-asset paths | The template already in production. |
| `worker/index.js` (shrunk) | CORS, `requireTenant`, dispatch, `safeError` | Becomes a thin router + shared middleware only. |

Front end (`src/`) is already component-modular; the one customary cleanup is the
**duplication** flagged in `CLAUDE.md` (`ScheduleCReport.jsx` vs `Tax.jsx`).

### 2.3 The module contract (each door gets a test)

For every extracted module, add `tests/contract.<module>.test.js` that asserts its
public behavior against a frozen fixture — the same discipline as the golden test.
That test is what turns "a file" into "an unbreakable block": the block is defined
by its test, not its code.

---

## 3. LAYER B — HASH-CHAINED AUDIT LEDGER (data)

This is your "hash to isolate" idea, placed where it earns its keep. It is
**additive** — a new table + write calls — and touches **no existing math**, which
is exactly why it's the safest first step.

### 3.1 The idea in one line

> Every mutation to a money table also writes one **append-only** audit row. Each
> row carries a SHA-256 hash of its own contents **plus the hash of the previous
> row for that tenant.** Alter or delete any past row and every hash after it
> breaks — the history becomes **tamper-evident**.

This is how ledgers, git, and blockchains all get integrity. Here it answers the
question a financial system must be able to answer and currently cannot: *"who
changed this load's base_pay, from what, to what, and when?"*

### 3.2 Proposed table (matches existing migration conventions)

```sql
-- migrations/00XX_audit_ledger.sql  (PROPOSAL — not applied)
CREATE TABLE IF NOT EXISTS audit_ledger (
  id          TEXT PRIMARY KEY,                 -- uuid
  tenant_id   TEXT NOT NULL,                    -- from SESSION, never client body
  seq         INTEGER NOT NULL,                 -- monotonic per tenant (chain order)
  entity      TEXT NOT NULL,                    -- 'loads' | 'carrier_advances' | 'settlement_payments' | 'recurring_charges'
  entity_id   TEXT NOT NULL,                    -- the mutated record's id
  action      TEXT NOT NULL,                    -- 'insert' | 'update' | 'delete'
  actor       TEXT NOT NULL,                    -- session user (who)
  before_json TEXT NOT NULL DEFAULT '',         -- prior row state ('' for insert)
  after_json  TEXT NOT NULL DEFAULT '',         -- new row state ('' for delete)
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  prev_hash   TEXT NOT NULL,                    -- row_hash of prior audit row (genesis const for seq=1)
  row_hash    TEXT NOT NULL,                    -- sha256(canonical(this row) + prev_hash)
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_tenant_seq ON audit_ledger(tenant_id, seq);
CREATE INDEX        IF NOT EXISTS idx_audit_entity     ON audit_ledger(tenant_id, entity, entity_id);
```

### 3.3 How the hash chain is computed

```
canonical = tenant_id | seq | entity | entity_id | action | actor
          | before_json | after_json | created_at | prev_hash      (fixed field order)
row_hash  = SHA-256(canonical)          // crypto.subtle.digest — available in Workers
prev_hash = row_hash of (tenant_id, seq-1); for seq=1 use a fixed GENESIS constant
```

Verification job walks each tenant's rows in `seq` order, recomputes every
`row_hash`, and confirms `prev_hash` links. One broken link = tampering, at a
known `seq`. This becomes a new golden-style test: **the chain must verify, or CI
fails.**

### 3.4 Honest limits (Rule 11)

- **Tamper-*evident*, not tamper-*proof*.** A full attacker with write access could
  recompute the whole chain forward. The value is detecting *accidental* or
  *single-row* corruption/edits — which is the real risk for a one-operator app —
  and giving you a provable history. True immutability later = periodically anchor
  the latest `row_hash` somewhere append-only (KV with versioning, or emailed to
  the owner). Out of scope for v1.
- **D1 write discipline:** the mutation + its audit row should land atomically.
  D1 supports `db.batch([...])` — use it so a mutation can never commit without its
  audit row. Still **one statement per `.prepare()`** (existing D1 rule); `batch`
  groups them.
- **`seq` under concurrency:** one live tenant makes races unlikely, but compute
  `seq`/`prev_hash` inside the batch by reading `MAX(seq)` for the tenant. Note as
  **verify-under-load** before multi-tenant launch.

---

## 4. SEQUENCING — safest first, never destroy the live app

Ordered so the **safety net is recording history before any code moves**, and
every step is independently shippable and reversible (Rule #1, Rule #9).

1. **Audit ledger, additive (Layer B).** New migration + a single `writeAudit()`
   helper called from the existing `PATCH`/`DELETE`/`POST` handlers. Touches no
   math, no settlement, no reports. Lowest risk, highest customary-value. Ship the
   chain-verify test with it.
2. **Formalize existing blocks' contracts.** Add `contract.*.test.js` for the
   modules that are *already* split (`ratecons`, `payments`, `signed`, `ifta`).
   Zero code movement — just pin their doors. Proves the pattern.
3. **Extract one Worker module per push,** smallest first
   (`drivers` → `brokers` → `advances` → `settlement` → `fuel` → `stops` →
   `loads` last). Each extraction: move routes, add its contract test, run the
   **golden test + full CI**, verify, push. `worker/index.js` shrinks to a router.
4. **Front-end dedup** (`ScheduleCReport` vs `Tax`) once the Worker is calm.

Each numbered step is a stopping point. We never need to hold a half-done refactor.

---

## 5. GUARDRAILS THIS PROPOSAL DOES NOT RELAX

Nothing here changes any of the following, and every step is checked against them:

- Settlement math stays solely in `src/settlementMath.js`; golden test run after
  every step (Law of Settlement Integrity).
- `PBKDF2_ITERATIONS = 100000` exactly. `DEFAULT_OWNER_CUT = 0.10` stays.
- Carrier cut on every driver, every load. Detention + lumper reimb = 100% driver.
- `tenant_id` from session, never client body (audit `actor`/`tenant_id` included).
- No whole-file rewrite of `worker/index.js` — extraction is surgical, one module
  per push. Work stays on the `claude/*` branch; `main` (auto-deploys) only by
  your explicit approval.
- Never edit the golden fixture to pass. Never request a secret in chat.

---

## 6. BEARDS DOCTRINE CHECK

- **Truth as Architecture** — history becomes a recorded, verifiable chain, not a
  thing reconstructed from memory.
- **Accountability Without Exception** — every money mutation carries who/what/when,
  walled by `tenant_id` like every other table.
- **Non-Exploitation / Sovereignty of the User** — each tenant's audit chain is
  its own; a correction is a visible reversing entry, never a silent overwrite.

---

## 7. OPEN QUESTIONS FOR YOU (before any of this is built)

1. Which tables must be audited on day one? Proposed: `loads`, `carrier_advances`,
   `settlement_payments`, `recurring_charges`. Add `escrow_payments`? `fuel_entries`?
2. Is a tamper-*evident* chain enough for v1, or do you want owner-anchoring
   (emailed/append-only hash) from the start?
3. Extraction appetite: all Worker modules over time, or just carve out the
   riskiest (`loads`, `fuel`) and leave the rest?

*Nothing in this document has been built. It is a plan to react to.*
