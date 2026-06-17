// src/settlementMath.js
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V4 — SHARED SETTLEMENT MATH — single source of truth
// 2026-06-12: extracted from SettlementReport.jsx so SettlementReport.jsx
//             and Maintenance.jsx compute the running balance with ONE
//             formula. Behavior identical to the 2026-06-11e code.
//
// ACCOUNTING MODEL — v2:
// "Still Owed to TIM" is a RUNNING BALANCE (all-time cumulative).
// It uses every load, every fuel entry, every ACH payment, every escrow
// payment ever recorded. Not period-filtered. Never resets.
// A load's accounting date is its DELIVERY DATE (rate con chronology).

// -- CONSTANTS — DO NOT CHANGE -----------------------------------------
export const BRUCE_CUT = 0.10
export const TIM_CUT   = 0.90

// Safely turn a D1 column that may be an array, a JSON string, null, or ''
// into a real array. Never throws.
export function asArray(val) {
  if (Array.isArray(val)) return val
  if (typeof val === 'string') {
    const s = val.trim()
    if (!s) return []
    try {
      const parsed = JSON.parse(s)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

// Parse any date format that exists in this app's data into a Date at
// local noon (prevents UTC midnight rolling back a day in Central time).
// Handles: YYYY-MM-DD | MM/DD/YYYY | M/D/YYYY | MM/DD/YY. Never throws.
export function parseAppDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null
  const s = dateStr.trim()
  // ISO: YYYY-MM-DD (with or without trailing time)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s.substring(0,10) + 'T12:00:00')
    return isNaN(d.getTime()) ? null : d
  }
  // US: M/D/YY or MM/DD/YYYY etc.
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (m) {
    const month = parseInt(m[1], 10)
    const day   = parseInt(m[2], 10)
    let year    = parseInt(m[3], 10)
    if (m[3].length === 2) year += 2000
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    const d = new Date(year, month - 1, day, 12, 0, 0)
    return isNaN(d.getTime()) ? null : d
  }
  return null
}

// -- LOAD HELPERS — DO NOT CHANGE --------------------------------------
// RATE CON CHRONOLOGY: a load's accounting date is its DELIVERY DATE.
// created_at (entry date) is only a last-resort fallback.
export function loadDate(load) { return load.delivery_date || load.date || load.created_at || null }

export function getLoadTotals(load) {
  const comdataTotal = parseFloat(load.comdata_total) > 0
    ? parseFloat(load.comdata_total)
    : asArray(load.comdatas).reduce((s,i) => s+(parseFloat(i.amount)||0), 0)
  const lumperTotal = parseFloat(load.lumper_total) > 0
    ? parseFloat(load.lumper_total)
    : asArray(load.lumpers).reduce((s,i) => s+(parseFloat(i.amount)||0), 0)
  const incTotal = parseFloat(load.incidental_total) > 0
    ? parseFloat(load.incidental_total)
    : asArray(load.incidentals).reduce((s,i) => s+(parseFloat(i.amount)||0), 0)
  return { comdataTotal, lumperTotal, incTotal }
}

export function calcPay(load) {
  const base      = parseFloat(load.base_pay) || 0
  const detention = parseFloat(load.detention) || 0
  if (load.driver === 'BRUCE') return { gross: base, ownerCut: base * BRUCE_CUT, driverNet: base }
  return { gross: base, ownerCut: base * BRUCE_CUT, driverNet: (base * TIM_CUT) + detention }
}

export function advanceKept(load) {
  const { comdataTotal, lumperTotal, incTotal } = getLoadTotals(load)
  return Math.max(0, comdataTotal - lumperTotal - incTotal)
}

export function reimbursementOwed(load) {
  const { comdataTotal, lumperTotal, incTotal } = getLoadTotals(load)
  return Math.max(0, (lumperTotal + incTotal) - comdataTotal)
}

// -- RUNNING BALANCE — all-time, the ONE formula ------------------------
// The true "what does Bruce owe Tim right now" number.
// stillOwedRaw is the signed balance (spec: can cross zero).
// stillOwed keeps the Math.max(0, ...) display cap — unchanged behavior.
export function computeRunningBalance({ loads, fuelEntries, escrowTotal, driver }) {
  const dn     = driver
  const dLoads = (Array.isArray(loads) ? loads : []).filter(l => l.driver === dn)
  const fuel   = Array.isArray(fuelEntries) ? fuelEntries : []
  const allGrossPay     = dLoads.reduce((s,l) => s + calcPay(l).driverNet, 0)
  const allAdvKept      = dLoads.reduce((s,l) => s + advanceKept(l), 0)
  const allReimb        = dLoads.reduce((s,l) => s + reimbursementOwed(l), 0)
  const allFleetFuel    = fuel.filter(f => f.driver === dn.toUpperCase() && f.fuel_type === 'fleet').reduce((s,f) => s+(parseFloat(f.amount)||0), 0)
  const allAchDisbursed = dLoads.filter(l => l.ach_payment).reduce((s,l) => s+(parseFloat(l.ach_received)||0), 0)
  const allEscrow       = parseFloat(escrowTotal) || 0
  const stillOwedRaw    = allGrossPay - allAdvKept + allReimb - allFleetFuel - allAchDisbursed - allEscrow
  return {
    allGrossPay, allAdvKept, allReimb, allFleetFuel, allAchDisbursed, allEscrow,
    allDetention: dLoads.reduce((s,l) => s+(parseFloat(l.detention)||0), 0),
    allGross90: dLoads.reduce((s,l) => s+(parseFloat(l.base_pay)||0)*TIM_CUT, 0),
    stillOwedRaw,
    stillOwed: Math.max(0, stillOwedRaw),
  }
}
