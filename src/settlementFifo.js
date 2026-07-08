// src/settlementFifo.js
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — OLDEST-LOAD-FIRST (FIFO) PAYMENT RECONCILIATION
//
// PURE + SIDE-EFFECT-FREE. Writes nothing. Reads nothing off the network. Given
// a driver's loads and the disbursements handed to that driver, it walks the
// loads oldest-first and applies each dollar of disbursement to the oldest load
// still owing, topping it off and rolling the remainder to the next-oldest load.
//
// WHY THIS EXISTS (Daddyboy spec, 2026-07-08):
//   The all-time "Balance Owed" in settlementMath.js is a REPORTING number and is
//   left byte-identical. Separately, when Edgerton hands Tim cash/check pay — OR a
//   general carrier advance — that money should reconcile the OLDEST unpaid load
//   forward. This module produces that per-load paid/partial/unpaid picture
//   WITHOUT touching the load-card carrier tools (Mark Billed / Mark Paid stay the
//   driver's own carrier-recording controls; this never reads or writes load.status).
//
// DISBURSEMENT SOURCES that pay down loads (both treated identically here):
//   1. settlement_payments rows (cash / check)                    -> paidType 'payment'
//   2. carrier_advances rows WHERE reason === 'general'           -> paidType 'advance'
//   EXCLUDED (never passed in / never fold into load paydown):
//     - carrier_advances reason 'repair' (loan vs repair bill)
//     - escrow_payments (driver's money vs repair bill)
//     - broker advance / comdata (already handled inside the load's own math)
//
// ORDERING — CRITICAL: load delivery_date is stored in MIXED string formats in
// live data (e.g. '4/7/2026', '05/21/2026', '2026-03-16'). A raw string sort is
// WRONG (it would order '05/21' before '4/7'). We sort with parseAppDate() — the
// same parser the live formula already uses — so "oldest" is TRUE chronology.
// created_at is the stable tiebreaker when two loads share a delivery date.

import { calcPay, loadDate, parseAppDate } from './settlementMath.js'

// The amount a single load is worth to the driver for paydown purposes.
// This mirrors the live per-load driver figure: driverNet from calcPay
// (base * (1 - ownerCut) + detention). Broker/fuel/escrow are NOT re-subtracted
// here — they belong to the all-time balance, not the per-load face value the
// driver is being paid out for. Keeping it to driverNet makes each load's
// "owed" equal exactly what the Rate Con / Driver Pay column shows.
export function loadDriverValue(load, ownerCutPct) {
  return calcPay(load, ownerCutPct).driverNet
}

// Sort key: TRUE chronological order, oldest first. Loads with an unparseable
// date sink to the end (newest) so a bad date never jumps the front of the line
// and swallows a payment. created_at breaks ties deterministically.
function chronoCompare(a, b) {
  const da = parseAppDate(loadDate(a))
  const db = parseAppDate(loadDate(b))
  if (da && db) {
    if (da.getTime() !== db.getTime()) return da.getTime() - db.getTime()
  } else if (da && !db) {
    return -1
  } else if (!da && db) {
    return 1
  }
  // tie (or both unparseable): fall back to created_at string, then id
  const ca = (a.created_at || '') + (a.id || '')
  const cb = (b.created_at || '') + (b.id || '')
  return ca < cb ? -1 : ca > cb ? 1 : 0
}

// Build the ordered list of disbursements (oldest first) from the two sources.
// Each becomes { id, kind, date, amount, ref } where kind is 'payment' | 'advance'.
function orderedDisbursements(payments, generalAdvances) {
  const pays = (Array.isArray(payments) ? payments : []).map(p => ({
    id: p.id,
    kind: 'payment',
    method: p.method || 'cash',
    ref: p.reference || '',
    date: p.paid_at || p.created_at || '',
    amount: Math.max(0, parseFloat(p.amount) || 0),
  }))
  const advs = (Array.isArray(generalAdvances) ? generalAdvances : [])
    // safety: only general, unrepaid advances top off loads
    .filter(a => (a.reason || 'general') === 'general')
    .filter(a => !a.repaid)
    .map(a => ({
      id: a.id,
      kind: 'advance',
      method: 'advance',
      ref: a.notes || '',
      date: a.advance_date || a.created_at || '',
      amount: Math.max(0, parseFloat(a.amount) || 0),
    }))
  const all = pays.concat(advs).filter(d => d.amount > 0)
  all.sort((x, y) => {
    const dx = parseAppDate(x.date)
    const dy = parseAppDate(y.date)
    if (dx && dy) {
      if (dx.getTime() !== dy.getTime()) return dx.getTime() - dy.getTime()
    } else if (dx && !dy) { return -1 } else if (!dx && dy) { return 1 }
    return (x.id || '') < (y.id || '') ? -1 : 1
  })
  return all
}

// -- THE RECONCILER ----------------------------------------------------------
// reconcileFifo({ loads, driver, ownerCutPct, payments, generalAdvances })
//   loads:           this driver's loads (booked loads should already be excluded
//                    by the caller, matching the settlement formula's billableLoads)
//   driver:          driver name string (loads are filtered to this driver)
//   ownerCutPct:     tenant carrier cut (fraction or whole; normalized downstream)
//   payments:        settlement_payments rows (cash/check)
//   generalAdvances: carrier_advances rows (only reason='general', unrepaid used)
//
// Returns {
//   loads:    [{ ...load, owed, paid, remaining, state, appliedFrom[] }]  (oldest first)
//   totals:   { loadsTotal, disbursedTotal, appliedTotal, unappliedTotal, unpaidRemaining }
//   fullyPaid, partiallyPaid, unpaid: counts
// }
// state is 'paid' | 'partial' | 'unpaid'. appliedFrom lists which disbursements
// hit that load and how much, so the UI can show a source trail per load.
export function reconcileFifo({ loads, driver, ownerCutPct, payments, generalAdvances }) {
  const dn = driver
  const dLoads = (Array.isArray(loads) ? loads : [])
    .filter(l => l.driver === dn)
    .slice()
    .sort(chronoCompare)

  const disb = orderedDisbursements(payments, generalAdvances)

  // Running pool of money to apply, consumed oldest disbursement first. We track
  // a queue so each load can record WHICH disbursement(s) paid it.
  const queue = disb.map(d => ({ ...d, left: d.amount }))
  let qi = 0

  const outLoads = dLoads.map(l => {
    const owed = round2(loadDriverValue(l, ownerCutPct))
    let remaining = owed
    const appliedFrom = []
    while (remaining > 0.0001 && qi < queue.length) {
      const d = queue[qi]
      if (d.left <= 0.0001) { qi++; continue }
      const take = Math.min(d.left, remaining)
      d.left = round2(d.left - take)
      remaining = round2(remaining - take)
      appliedFrom.push({ id: d.id, kind: d.kind, method: d.method, ref: d.ref, date: d.date, amount: round2(take) })
      if (d.left <= 0.0001) qi++
    }
    const paid = round2(owed - remaining)
    const state = remaining <= 0.0001 ? 'paid' : (paid > 0.0001 ? 'partial' : 'unpaid')
    return { ...l, owed, paid, remaining: round2(remaining), state, appliedFrom }
  })

  const loadsTotal      = round2(outLoads.reduce((s, l) => s + l.owed, 0))
  const disbursedTotal  = round2(queue.reduce((s, d) => s + d.amount, 0))
  const unappliedTotal  = round2(queue.reduce((s, d) => s + Math.max(0, d.left), 0))
  const appliedTotal    = round2(disbursedTotal - unappliedTotal)
  const unpaidRemaining = round2(outLoads.reduce((s, l) => s + l.remaining, 0))

  return {
    loads: outLoads,
    totals: { loadsTotal, disbursedTotal, appliedTotal, unappliedTotal, unpaidRemaining },
    fullyPaid:     outLoads.filter(l => l.state === 'paid').length,
    partiallyPaid: outLoads.filter(l => l.state === 'partial').length,
    unpaid:        outLoads.filter(l => l.state === 'unpaid').length,
  }
}

// Money rounding to cents — avoids float drift accumulating across a long cascade.
function round2(n) {
  return Math.round(((parseFloat(n) || 0) + Number.EPSILON) * 100) / 100
}
