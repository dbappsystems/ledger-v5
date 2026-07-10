# HANDOFF — IFTA Home-Anchored Rounds (Path C odometer estimate)

**Status:** in progress. This doc is the design of record. Build follows it.
**Owner:** dbappsystems / Load Ledger V5. IFTA-only; settlement math untouched.

---

## THE MODEL (as agreed)

A driver leaves HOME, runs loads, and eventually goes HOME. That bracket is a
ROUND. A round opens and closes on two REAL odometer readings the driver reads
off the dash at the same physical place (home). Everything between is
forward-derived from the opening reading and made verifiable.

    HOME (depart odo, FACT)
      -> deadhead home->pickup1        (estimated)
      -> load1 loaded legs             (estimated, split by state)
      -> deadhead drop1->pickup2       (estimated)     [continuation]
      -> load2 loaded legs             (estimated)
      ...
      -> [driver fires "going home"]
      -> deadhead lastDrop->HOME       (estimated)
    HOME (arrival odo, FACT)           <- finalizes the closing leg + reconciles

Going home is a DELIBERATE driver action, never inferred from "no next load."
A run can continue far from home across many loads. Only the driver knows when
the round ends.

## HARD RULES (carried from the live system)

- **Estimate never outranks fact.** A load with any `driver-manual` segment
  hides its `routed-estimate` segments in the summary. The manual apply already
  deletes a load's segments before writing fact.
- **Single fact write path.** Promotion of estimate->fact reuses
  `POST /api/ifta/manual` (pre-filled form, driver confirms). No parallel write
  path into the fact tables.
- **Integrity identity (round level):**
  `sum(all round segment miles) === home_arrival_odo - home_depart_odo` to 0.1 mi.
  The per-chain identity (`sum seg === last - first`) is the twin already
  enforced in ifta_manual.js buildChain and now in ifta.js buildEstimatedChain.
- **Forward-derived only.** Every estimated odometer value = a real anchor +
  routed miles going forward. No back-derivation of an unobserved reading.
- **Home is a coordinate + a per-cycle odometer.** Coordinate is fixed per
  driver (stored). Odometer is entered each round (changes every cycle).

## HOME

- Tim's home: lat `38.885871`, lon `-90.130106`.
- Stored on `drivers.home_lat` / `drivers.home_lon` (added), NOT hardcoded in
  logic. Logic reads the driver's home; falls back to a labeled default constant
  only if the columns are null, so a mis-seeded driver still routes.

## SCHEMA CHANGES (D1 — one statement per call)

1. `ALTER TABLE drivers ADD COLUMN home_lat REAL;`
2. `ALTER TABLE drivers ADD COLUMN home_lon REAL;`
3. `ALTER TABLE ifta_segments ADD COLUMN round_id TEXT;`   -- nullable, links seg->round
4. `ALTER TABLE ifta_miles    ADD COLUMN round_id TEXT;`   -- nullable, links mile->round
5. CREATE TABLE ifta_rounds (
     id TEXT PRIMARY KEY,
     tenant_id TEXT,
     driver TEXT,
     status TEXT DEFAULT 'open',            -- 'open' | 'closing' | 'closed'
     home_lat REAL, home_lon REAL,          -- snapshot of home used this round
     depart_odo REAL,                       -- FACT: odo leaving home (opens round)
     arrival_odo REAL,                      -- FACT: odo arriving home (closes round)
     opened_at TEXT DEFAULT (datetime('now')),
     closed_at TEXT,
     notes TEXT DEFAULT ''
   );

All existing rows unaffected: new columns nullable, no default rewrite.

## ENDPOINTS

- `POST /api/ifta/round/open`   { driver, depart_odo, date }
    -> creates ifta_rounds row status='open', snapshots driver home. Returns round_id.
- `POST /api/loads/:id/route-ifta`  (extended)
    body may carry { round_id?, start_odometer? }.
    - Resolves anchor: entered start_odometer > prior segment odo_end > round depart_odo > none.
    - Writes loaded-leg estimate segments (source='routed-estimate') + the
      home->pickup deadhead leg when this load is the round's first load.
    - Stamps round_id on segments + miles when a round is active.
- `POST /api/ifta/round/close`  { round_id }  ("going home")
    -> routes last drop -> home, appends estimated closing deadhead leg,
       sets status='closing'. Closing leg is ESTIMATE until arrival odo entered.
- `POST /api/ifta/round/finalize` { round_id, arrival_odo }
    -> sets arrival_odo (FACT), status='closed', reconciles: distribute
       (arrival_odo - depart_odo - sum_estimated_miles) drift proportionally
       across the round's estimate segments so the round identity holds exactly.
       Fact home readings bracket the round.

Reconciliation reuses the proportional-by-mile-share method already used on the
fuel side; it does NOT overwrite any driver-manual (fact) segment — only
routed-estimate segments are adjusted.

## DEADHEAD ANCHORING (the resolved question)

- **Home -> first pickup:** first load of a round. Anchored by round depart_odo
  (FACT). Forward-derived. Always chains.
- **Drop -> next pickup:** continuation. Anchored by prior load's odo_end.
  Auto-derived when a next load exists. Forward-derived.
- **Last drop -> home:** the "going home" leg. Fired deliberately via round/close.
  Anchored by last segment odo_end, closes at estimated home arrival, finalized
  to FACT by round/finalize.

No deadhead is ever back-derived. If no anchor exists (no round, no prior chain,
no entered odo), miles are written but no odometer segment — honest miles-only.

## BUILD ORDER

1. This HANDOFF doc (repo record).                                  [pushing now]
2. Schema: 5 D1 statements, one per call, verified after each.
3. worker/ifta.js — chain engine + home-leg + round_id stamping.
   (chain engine already written + integrity-tested this session.)
4. worker/ifta_manual.js — accept round finalize/reconcile (fact path).
5. worker/index.js — route new endpoints + pass round_id/start_odometer.
6. AI-MAP.md — document rounds model + new table/columns/routes.

Each code push: fresh blob SHA -> edit -> Babel/node --check -> expected blob
SHA -> push -> re-fetch at new SHA -> verify. worker/index.js targeted edits
only, never whole-file.

## FRONT-END (later, not this worker build)

- "Leave home" -> enter depart odo -> round/open.
- Loads route as normal; estimate chain appears tagged pending.
- "Going home" button -> round/close.
- Arrive -> enter home odo -> round/finalize -> round closes on fact.
- Estimate segments pre-fill the manual IVDR form for per-load fact promotion
  via existing /api/ifta/manual.
