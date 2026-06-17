// src/settlementMath.js
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — SHARED SETTLEMENT MATH — single source of truth
//
// WHITE-LABEL: no hardcoded names, no hardcoded split.
//   * The owner's cut comes from the TENANT SETTING (driver_split_pct, 1..50),
//     passed in as `ownerCutPct` (a fraction 0.01..0.50). Default 0.10 only as
//     a safety fallback if a caller forgets to pass it.
//   * "Owner-operator" loads (driver keeps 100%, no split) are flagged per-load
//     via load.is_owner_operator instead of matching a hardcoded name like BRUCE.
//
// ACCOUNTING MODEL (unchanged from v4 behavior):
//   "Still owed to the company" is an all-time RUNNING BALANCE. Uses every load,
//   fuel entry, ACH payment, and escrow payment. Not period-filtered, never
//   resets. A load's accounting date is its DELIVERY DATE.

// -- SPLIT HELPERS (replaces hardcoded BRUCE_CUT / TIM_CUT) -------------------
// ownerCutPct is a fraction: 0.10 means the company keeps 10%, driver nets 90%.
const DEFAULT_OWNER_CUT = 0.10; // fallback ONLY; real value comes from tenant.

export function normalizeOwnerCut(pctMaybeWhole) {
  // Accept either a fraction (0.10) or a whole number (10) and clamp to 1%..50%.
  if (pctMaybeWhole == null || isNaN(pctMaybeWhole)) return DEFAULT_OWNER_CUT;
  let f = Number(pctMaybeWhole);
  if (f > 1) f = f / 100;            // 10 -> 0.10
  if (f < 0.01) f = 0.01;            // floor 1%
  if (f > 0.50) f = 0.50;            // ceiling 50%
  return f;
}

// Safely turn a D1 column that may be an array, JSON string, null, or '' into
// a real array. Never throws.
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

// Parse any date format in this app's data into a Date at local noon (prevents
// UTC midnight rolling back a day in Central time). Never throws.
export function parseAppDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null
  const s = dateStr.trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s.substring(0,10) + 'T12:00:00')
    return isNaN(d.getTime()) ? null : d
  }
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

// -- LOAD HELPERS ------------------------------------------------------------
// RATE CON CHRONOLOGY: a load's accounting date is its DELIVERY DATE.
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

// calcPay now takes the owner cut as a parameter (from the tenant setting).
//   ownerCutPct: fraction the COMPANY keeps (e.g. 0.10).
//   An owner-operator load (load.is_owner_operator truthy) keeps 100%: the
//   driver nets the full base and the company cut is reported as 0 for that load
//   — same effect the old code achieved by checking `driver === 'BRUCE'`, but
//   now driven by per-load data instead of a hardcoded name.
export function calcPay(load, ownerCutPct = DEFAULT_OWNER_CUT) {
  const cut       = normalizeOwnerCut(ownerCutPct)
  const base      = parseFloat(load.base_pay) || 0
  const detention = parseFloat(load.detention) || 0
  if (load.is_owner_operator) {
    return { gross: base, ownerCut: 0, driverNet: base }
  }
  return { gross: base, ownerCut: base * cut, driverNet: (base * (1 - cut)) + detention }
}

export function advanceKept(load) {
  const { comdataTotal, lumperTotal, incTotal } = getLoadTotals(load)
  return Math.max(0, comdataTotal - lumperTotal - incTotal)
}

export function reimbursementOwed(load) {
  const { comdataTotal, lumperTotal, incTotal } = getLoadTotals(load)
  return Math.max(0, (lumperTotal + incTotal) - comdataTotal)
}

// -- RUNNING BALANCE — all-time, the ONE formula -----------------------------
// Now takes ownerCutPct from the tenant. Behavior identical to v4 when
// ownerCutPct = 0.10 and no loads are flagged owner-operator.
export function computeRunningBalance({ loads, fuelEntries, escrowTotal, driver, ownerCutPct = DEFAULT_OWNER_CUT }) {
  const cut    = normalizeOwnerCut(ownerCutPct)
  const dn     = driver
  const dLoads = (Array.isArray(loads) ? loads : []).filter(l => l.driver === dn)
  const fuel   = Array.isArray(fuelEntries) ? fuelEntries : []
  const allGrossPay     = dLoads.reduce((s,l) => s + calcPay(l, cut).driverNet, 0)
  const allAdvKept      = dLoads.reduce((s,l) => s + advanceKept(l), 0)
  const allReimb        = dLoads.reduce((s,l) => s + reimbursementOwed(l), 0)
  const allFleetFuel    = fuel.filter(f => f.driver === dn.toUpperCase() && f.fuel_type === 'fleet').reduce((s,f) => s+(parseFloat(f.amount)||0), 0)
  const allAchDisbursed = dLoads.filter(l => l.ach_payment).reduce((s,l) => s+(parseFloat(l.ach_received)||0), 0)
  const allEscrow       = parseFloat(escrowTotal) || 0
  const stillOwedRaw    = allGrossPay - allAdvKept + allReimb - allFleetFuel - allAchDisbursed - allEscrow
  return {
    allGrossPay, allAdvKept, allReimb, allFleetFuel, allAchDisbursed, allEscrow,
    allDetention: dLoads.reduce((s,l) => s+(parseFloat(l.detention)||0), 0),
    allGrossCompanyShare: dLoads.reduce((s,l) => s+(parseFloat(l.base_pay)||0)*(1 - cut), 0),
    stillOwedRaw,
    stillOwed: Math.max(0, stillOwedRaw),
  }
}
