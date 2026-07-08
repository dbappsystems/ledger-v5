# LAW — Settlement Integrity

**Status: permanent law. Do not weaken. Do not delete.**
**Guarded by:** `tests/settlement.golden.test.js` (run: `node tests/settlement.golden.test.js`)

---

## The one sentence

> **A settlement number is computed in exactly one authoritative place. Every other place that shows that number must READ it, never RE-DERIVE it — and where a second computation is unavoidable, it must reconcile to the authoritative one to the penny, or fail loudly.**

That is the whole law. Everything below is why it exists and how it is enforced.

---

## Why this law exists (the two bugs that wrote it)

Two production defects in TIM's settlement had the **same root cause**, and it was
never the math itself:

1. **FIFO $4,250 over-credit.** The "Total Unpaid Earnings" panel read **$7,259.53**
   while the real Balance Owed was **$3,009.53** — a gap of exactly **$4,250.00**.
   Cause: `buildFifoLedger` called `calcPay(l)` **without passing the tenant split**,
   so it silently fell back to the 10% default instead of Edgerton's 15%. Every
   load was over-credited by `base × 0.05`. Across TIM's $85,000 in base pay, that
   is precisely $4,250.

2. **$0.00 Gross Pay row.** The statement header printed a dead field
   (`allGross90`) that no longer existed, showing `$0.00` while the correct
   $72,250 was used *inside* the balance but never displayed.

**`settlementMath.js` was correct both times.** The bugs lived in the DISPLAY and
AUDIT paths, which re-derived numbers instead of consuming the authoritative one.
The danger to this app's money is not "the formula is wrong." It is
**"the same truth is computed twice and allowed to disagree."**

---

## The authoritative source

`src/settlementMath.js` → `computeRunningBalance(...)` is the ONE formula for
"what does the company owe this driver right now." Its result — especially
`stillOwed` / `stillOwedRaw` and every `all*` component — is the truth. The split
comes from the tenant (`tenants.driver_split_pct`, passed as `ownerCutPct`).

**The DADDYBOY RULE stands inside this law:** every driver is charged the carrier
rate on every load, owner-operators included. There is no exemption branch.

---

## The identities that must hold forever

The golden test asserts each of these to the penny against a frozen live snapshot
(tenant `ten_edgerton`, driver TIM, 15% split, captured 2026-07-08):

| # | Identity | What it protects |
|---|----------|------------------|
| 1 | **GOLDEN** — TIM's balance == **$3,009.53** | The known-good number. Any drift = a regression. |
| 2 | **RECON** — FIFO net unpaid == `stillOwedRaw` | The display/audit path can never silently disagree with the authoritative one. This alone would have caught the $7,259 bug the instant it ran. |
| 3 | **DRIFT PROBE** — omitting the split reproduces the **$4,250** gap | Proves the original bug is still *detectable*, and that the live call avoids it (zero drift at 15%). |
| 4 | **COMPONENT** — `allGrossPay == companyShare + detention` | Detention flows exactly one way — never double-counted, never zeroed. |
| + | **INDEPENDENT** — a hand rebuild with no module code == the module | A second, from-scratch witness to the same $3,009.53. |

If any of these fail, a settlement number changed. **Do not deploy until the cause
is understood.** A green run means the books check their own arithmetic.

---

## The 0.10 that must stay 0.10

`DEFAULT_OWNER_CUT = 0.10` in `settlementMath.js` is **not** Edgerton's rate — it is
the safety fallback that fires only if a caller forgets to pass the tenant split.
**Leave it at 0.10 on purpose.** It is the bait in the DRIFT PROBE: if any code
ever falls back to it instead of passing the real 15%, the balance jumps wrong and
the test screams. Changing this constant to 0.15 would *disable the tripwire that
caught the original bug.* The live rate is, and remains, the tenant value (15%).

---

## Standing rules for anyone (human or AI) touching settlement

1. **Read, don't re-derive.** Any figure shown in a report, PDF, paystub, or audit
   trail reads from `computeRunningBalance` / `settlementMath`. Do not recompute
   from raw loads in a component.
2. **If a second computation is truly needed** (FIFO allocation genuinely is
   different logic), it must be fed the SAME inputs the authoritative path used,
   passed explicitly — never re-fetched, never defaulted — and it must reconcile
   (identity #2).
3. **A missing split must scream, not shrug.** Never let a silent 10% fallback
   produce a plausible-but-wrong number.
4. **Show the truth, then clamp for display — never before.** `stillOwed` is
   `Math.max(0, stillOwedRaw)`; `stillOwedRaw` stays visible so a real negative
   (over-deduction, double payment) is never hidden.
5. **Run the golden test before every settlement-touching deploy.** Green or it
   does not ship. This is the tripwire that protects the working live app — it
   tells you a change broke the math while it is still on your phone, not after
   Bruce and Tim see wrong pay.

---

## Keeping the fixture honest

The snapshot in the test is real live data, verified to the penny. If the
underlying live data is intentionally corrected (a misattributed load fixed, a rate
changed), the fixture and its `ANCHORS` are updated **in the same commit**, with the
new expected numbers re-derived from D1 — never hand-fudged to make a red test
green. A test edited to pass without understanding the failure is a lie, and this
law exists to make lies loud.

*Truth as Architecture: the app checks its own books.*
