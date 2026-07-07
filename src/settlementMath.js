// src/settlementMath.js
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — SHARED SETTLEMENT MATH — single source of truth
//
// WHITE-LABEL: no hardcoded names, no hardcoded split.
//   * The owner's cut comes from the TENANT SETTING (driver_split_pct, 1..50),
//     passed in as `ownerCutPct` (a fraction 0.01..0.50). Default 0.10 only as
//     a safety fallback if a caller forgets to pass it.
//   * EVERY driver is charged the carrier rate on EVERY load, owner operators
//     included (DADDYBOY RULE). There is no 100%-keep exemption in the math.
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

// calcPay takes the owner cut as a parameter (from the tenant setting).
//   ownerCutPct: fraction the CARRIER keeps (e.g. 0.15 = carrier keeps 15%).
//   DADDYBOY RULE (permanent): EVERY driver is charged the carrier rate on EVERY
//   load — owner operators included. There is NO 100%-keep exemption. The old
//   `if (load.is_owner_operator) keep 100%` branch has been removed so no flag,
//   on the load or the driver, can ever zero out the carrier's cut.
export function calcPay(load, ownerCutPct = DEFAULT_OWNER_CUT) {
  const cut       = normalizeOwnerCut(ownerCutPct)
  const base      = parseFloat(load.base_pay) || 0
  const detention = parseFloat(load.detention) || 0
  return { gross: base, ownerCut: base * cut, driverNet: (base * (1 - cut)) + detention }
}

// BROKER ADVANCE (Comdata / Express Code) — the leftover after a load's comdata
// covers its own lumpers/incidentals. This is money the BROKER advanced the
// driver directly against the load: anything beyond the offsetting costs is cash
// the driver already collected, so it REDUCES that driver's settlement. Display
// this line as "Broker Advance (Comdata)" on the settlement side. (Internal name
// kept as advanceKept so existing callers are undisturbed; brokerAdvanceKept is
// a same-value alias for new, clearly-labeled UI.)
export function advanceKept(load) {
  const { comdataTotal, lumperTotal, incTotal } = getLoadTotals(load)
  return Math.max(0, comdataTotal - lumperTotal - incTotal)
}
export const brokerAdvanceKept = advanceKept; // alias: settlement label "Broker Advance (Comdata)"

export function reimbursementOwed(load) {
  const { comdataTotal, lumperTotal, incTotal } = getLoadTotals(load)
  return Math.max(0, (lumperTotal + incTotal) - comdataTotal)
}

// CARRIER ADVANCE — a direct carrier->driver loan (breakdown/repair/general/fuel),
// separate from broker billing. An UNREPAID advance is money the carrier already
// handed the driver, so it reduces what the company still owes the driver, the
// same direction as fuel and escrow. Repaid advances (repaid truthy) are closed
// and do NOT reduce the balance. Accepts the rows returned by /api/carrier-advances.
export function carrierAdvanceOwed(carrierAdvances) {
  const list = Array.isArray(carrierAdvances) ? carrierAdvances : []
  return list
    .filter(a => !a.repaid)
    .reduce((s,a) => s + (parseFloat(a.amount) || 0), 0)
}

// RECURRING CHARGES — standing weekly carrier deductions: insurance, plate (IRP)
// installments, payment plans. Each row from /api/recurring-charges stores its
// NATURAL amount + cadence; this turns one row into the dollar figure that hits
// ONE settlement week. The result is what the paystub shows on its own line and
// what feeds TOTAL DEDUCTIONS for that week.
//
//   cadence 'weekly'  -> amount is already the per-week figure.
//   cadence 'monthly' -> amount is per-month; sliced to the week as amount*12/52
//                        so a $1,200/mo insurance line shows ~$276.92/week, never
//                        the whole month dumped into a single week (Non-Exploitation).
//
// A charge applies to a week only if it is active AND the week's pay date falls
// on/after start_date and on/before end_date (blank dates = open-ended). Pass the
// week's payDate (a Date) so the date window is judged on the day the driver is
// actually paid.
export function recurringChargeWeeklyAmount(charge) {
  const amt = parseFloat(charge.amount) || 0
  if (amt <= 0) return 0
  const cadence = (charge.cadence || 'weekly').toLowerCase()
  if (cadence === 'monthly') return amt * 12 / 52   // monthly -> weekly slice
  return amt                                          // weekly (default)
}

export function recurringChargeAppliesToWeek(charge, weekPayDate) {
  if (!charge || charge.active === 0 || charge.active === '0' || charge.active === false) return false
  const pay = weekPayDate instanceof Date ? weekPayDate : parseAppDate(weekPayDate)
  if (!pay) return true // no week date to judge against -> don't hide the charge
  const start = parseAppDate(charge.start_date)
  const end   = parseAppDate(charge.end_date)
  if (start && pay < start) return false
  if (end) {
    // inclusive of the end day
    const endEod = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999)
    if (pay > endEod) return false
  }
  return true
}

// Build the per-week recurring-charge lines for a driver: one entry per active,
// in-window charge with its sliced weekly dollar amount. Returns { rows, total }.
// `rows` are display-ready: { label, charge_type, amount }.
export function recurringChargesForWeek(recurringCharges, driverName, weekPayDate) {
  const list = Array.isArray(recurringCharges) ? recurringCharges : []
  const dn = (driverName || '').toUpperCase()
  const rows = list
    .filter(c => (c.driver || '').toUpperCase() === dn)
    .filter(c => recurringChargeAppliesToWeek(c, weekPayDate))
    .map(c => {
      const amount = recurringChargeWeeklyAmount(c)
      const typeLabel = ({
        insurance: 'Insurance', plates: 'Plates / IRP',
        payment_plan: 'Payment Plan', other: 'Recurring Charge',
      })[(c.charge_type || 'other')] || 'Recurring Charge'
      return {
        label: (c.label && c.label.trim()) ? c.label.trim() : typeLabel,
        charge_type: c.charge_type || 'other',
        cadence: (c.cadence || 'weekly').toLowerCase(),
        amount,
      }
    })
    .filter(r => r.amount > 0)
  const total = rows.reduce((s, r) => s + r.amount, 0)
  return { rows, total }
}

// -- RUNNING BALANCE — all-time, the ONE formula -----------------------------
// Takes ownerCutPct from the tenant. The carrier cut is applied to every load
// for every driver — no owner-operator exemption (DADDYBOY RULE).
//
// carrierAdvances (OPTIONAL): array of carrier_advances rows for this driver.
//   Omit it (or pass []) and the result is byte-identical to before — this is
//   what keeps existing settlements unchanged until the UI begins supplying
//   advances. Unrepaid advances subtract from stillOwed, like fuel/escrow.
//
// NOTE on recurring charges: the all-time running balance intentionally does NOT
// fold in recurring_charges. Insurance/plates/payment-plans are PER-WEEK
// settlement deductions shown on the weekly paystub (see recurringChargesForWeek),
// not part of the all-time "still owed to the company" load/fuel/advance balance.
// Keeping them out of computeRunningBalance keeps that number byte-identical to
// v4 and avoids double-counting a weekly deduction against the lifetime balance.
export function computeRunningBalance({ loads, fuelEntries, escrowTotal, driver, ownerCutPct = DEFAULT_OWNER_CUT, carrierAdvances = [] }) {
  const cut    = normalizeOwnerCut(ownerCutPct)
  const dn     = driver
  const dLoads = (Array.isArray(loads) ? loads : []).filter(l => l.driver === dn)
  const fuel   = Array.isArray(fuelEntries) ? fuelEntries : []
  const allGrossPay      = dLoads.reduce((s,l) => s + calcPay(l, cut).driverNet, 0)
  const allAdvKept       = dLoads.reduce((s,l) => s + advanceKept(l), 0)
  const allReimb         = dLoads.reduce((s,l) => s + reimbursementOwed(l), 0)
  const allFleetFuel     = fuel.filter(f => f.driver === dn.toUpperCase() && f.fuel_type === 'fleet').reduce((s,f) => s+(parseFloat(f.amount)||0), 0)
  const allAchDisbursed  = dLoads.filter(l => l.ach_payment).reduce((s,l) => s+(parseFloat(l.ach_received)||0), 0)
  const allEscrow        = parseFloat(escrowTotal) || 0
  const allCarrierAdvance = carrierAdvanceOwed(carrierAdvances)
  const stillOwedRaw     = allGrossPay - allAdvKept + allReimb - allFleetFuel - allAchDisbursed - allEscrow - allCarrierAdvance
  return {
    allGrossPay, allAdvKept, allReimb, allFleetFuel, allAchDisbursed, allEscrow,
    allCarrierAdvance,
    allDetention: dLoads.reduce((s,l) => s+(parseFloat(l.detention)||0), 0),
    allGrossCompanyShare: dLoads.reduce((s,l) => s+(parseFloat(l.base_pay)||0)*(1 - cut), 0),
    stillOwedRaw,
    stillOwed: Math.max(0, stillOwedRaw),
  }
}
