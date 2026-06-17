// src/Tax.jsx
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — Tax Desk
//
// AUTH MIGRATION: fuel + maintenance + (conditional) escrow fetches now go
// through the token api() client. The `api` URL prop is gone.
//
// WHITE-LABEL TODO: STATE_RATES is keyed by the hardcoded driver names
// BRUCE/TIM (Wisconsin/Illinois). Per-driver state tax rate is legitimate
// business data, but it must be keyed off the tenant's own drivers / a
// per-driver state setting, not two fixed names. Likewise the escrow/payback
// dataset is fetched only for the hardcoded driver 'TIM'.
//
// 2026-06-11: robust date parsing — delivery_date is stored as MM/DD/YYYY,
//             M/D/YYYY, or MM/DD/YY from the rate con scanner, while fuel
//             and maintenance use YYYY-MM-DD. parseAppDate() handles all
//             formats so quarter revenue is no longer $0. Revenue is
//             accounted by DELIVERY DATE (rate con chronology).
// 2026-06-11b: per diem entered as DAY COUNTS, not dollars. Full day = $80,
//             half day = $60 (IRS 75% partial-day method). Both x 80%
//             deductible for DOT drivers (IRS Notice 2025-54).
// 2026-06-11d: ACCRUAL — ALL repairs deduct at entry_date (when incurred),
//             including financed ones. Payback payments are DEBT SERVICE,
//             never deductions — the payments box is informational only.
//
// AUTO-PULL: Fuel from /api/fuel/{driver}; repairs from /api/maintenance/{driver}
// (all deduct at entry_date); financed-repair payback shown informational only.

import { useState, useEffect } from 'react'
import { api as apiClient } from './api.js'

const YEAR = 2026

// IRS Notice 2025-54 — transportation industry special M&IE rates
// (effective Oct 1, 2025; update these two numbers each October)
const PER_DIEM_FULL       = 80    // full day away from home, CONUS
const PER_DIEM_HALF       = 60    // half day — IRS 75% partial-day method
const PER_DIEM_DEDUCTIBLE = 0.80  // 80% deductible for DOT drivers (since Jan 2023)

const QUARTERS = [
  { label:'Q1', title:'January - March',     months:[0,1,2],    due:'2026-04-15', dueLabel:'April 15, 2026',     color:'#1e88e5' },
  { label:'Q2', title:'April - May',          months:[3,4],      due:'2026-06-15', dueLabel:'June 15, 2026',      color:'#8e24aa' },
  { label:'Q3', title:'June - August',        months:[5,6,7],    due:'2026-09-15', dueLabel:'September 15, 2026', color:'#e65100' },
  { label:'Q4', title:'September - December', months:[8,9,10,11],due:'2027-01-15', dueLabel:'January 15, 2027',   color:'#2e7d32' },
]

const FED_DEFAULT = 12

// WHITE-LABEL TODO: keyed by hardcoded driver names. Move to per-driver setting.
const STATE_RATES = {
  TIM:   { rate:0.0495, label:'Illinois',  default:4.95 },
  BRUCE: { rate:0.0530, label:'Wisconsin', default:5.30 },
}

const EXPENSE_CATEGORIES = [
  {
    label: 'Truck & Equipment',
    items: [
      'Tires & Brakes','Engine Repairs','Oil Change & Filters','Belt & Seal Repairs',
      'Injector Service','Truck Washing / Detailing','APU Purchase & Maintenance',
      'Trailer Lease / Rental','Trailer Repair & Maintenance','Truck Loan Interest',
      'Truck Lease Payments','Truck Depreciation (Section 179)','Trailer Depreciation',
      'Bobtail Insurance','Non-Trucking Liability Insurance','Occupational Accident Insurance',
      'Cargo Insurance','Physical Damage Insurance','Primary Liability Insurance',
      'Reefer Unit Maintenance','Registration Fees','Truck Inspection Fees',
    ],
  },
  {
    label: 'Fuel & Road Costs',
    items: [
      'DEF (Diesel Exhaust Fluid)','Fuel Additives','Reefer Fuel',
      'Bridge Tolls & Turnpike Fees','Scale Fees','Weigh Station Fees',
      'IFTA Fuel Taxes','State Fuel Taxes','Oversize / Overweight Permit Fees',
      'Port Fees & Terminal Access Fees','Lumper Fees (Unreimbursed)',
      'Comdata / EFS Transaction Fees','Overnight Parking','Parking at Shippers/Receivers',
    ],
  },
  {
    label: 'Travel, Meals & Per Diem',
    items: [
      'Hotel / Motel Stays','Short-Term Rental While on Job',
      'Truck Stop Shower Fees','Laundry While on the Road',
      'Sleeper Berth Supplies (Refrigerator, Bedding, Cleaning)',
    ],
  },
  {
    label: 'Licenses, Permits & Compliance',
    items: [
      'Heavy Highway Vehicle Use Tax (Form 2290)','CDL Renewal Fees',
      'Hazmat Endorsement Fees','CDL Safety Training / Seminar',
      'MC / DOT Authority Filing Fees','UCR (Unified Carrier Registration)',
      'IRP Apportioned Registration','BOC-3 Process Agent Fees',
      'FMCSA Portal Fees','DOT Medical Exam / Physical',
      'Drug & Alcohol Testing Program Fees','TWIC Card Fees',
      'TSA / Hazmat Background Check','Pre-Employment Background Check',
      'MVR (Motor Vehicle Record) Pull Fees',
    ],
  },
  {
    label: 'Tools, Safety & Gear',
    items: [
      'Chains, Tarps & Straps','Tire Irons & Air Tools',
      'Fire Extinguisher','Emergency Triangles',
      'Load Binders & Wheel Chocks','Steel-Toed Boots',
      'Hi-Vis Vests, Hard Hats, Gloves, Rain Gear','Required Uniforms (Logo)',
      'ELD Device (Purchase or Lease)','Dashcam (Purchase & Subscription)',
      'GPS Unit','CB Radio','Inverter / Power Converter',
      'Jump Pack / Battery Jump Starter','Tire Pressure Monitoring System',
      'Bungee Cords, Load Locks, Dunnage','Pallet Jack','Logbooks / Paper Logs',
    ],
  },
  {
    label: 'Technology & Communications',
    items: [
      'Cell Phone & Data Plan (Business Use %)','Tablet or Laptop (Business Use %)',
      'Load Board Subscription (DAT, Truckstop.com)','TMS Software',
      'Trucking Accounting Software','ELD Software / Subscription',
      'Satellite Communication Service','Dispatch Software / App',
      'Fuel Optimization App','GPS Subscription Service',
      'Business Apps & Software',
    ],
  },
  {
    label: 'Office & Administrative',
    items: [
      'Office Supplies (Stationery, Pens, Printer)','Postage & Shipping',
      'Tax Preparation Fees (CPA)','Bookkeeping / Accounting Fees',
      'Legal Fees (Business Related)','Factoring Fees',
      'Business Loan Interest','Business Credit Card Interest',
      'Business Bank Account Fees','Check Printing Fees',
      'Website Hosting & Domain','Online Ads & Business Cards',
      'Freight Broker Fees (Out of Pocket)','Home Office Deduction',
      'Internet Service (Business Use %)','OOIDA Membership Dues',
      'State Trucking Association Dues','Roadside Assistance Membership',
      'Industry Publications / Magazines','Conference Attendance',
    ],
  },
  {
    label: 'Often Overlooked',
    items: [
      'Scale Tickets','DOT Physicals / Medical Cards',
      'Bank Wire / ACH Transfer Fees','Interest on Business Line of Credit',
      'Start-Up Costs (New Business)','Detention Time Costs',
      'SEP-IRA / Solo 401(k) Contributions','State & Local Taxes (SALT)',
      'Property Taxes on Business Property','Excise Taxes',
      'Fuel Taxes Paid via IFTA','Pre-Trip Inspection Costs',
    ],
  },
]

function getStorageKey(driver) { return 'll_v5_tax_' + driver.toLowerCase() }
function loadStorage(driver) {
  try { const s = localStorage.getItem(getStorageKey(driver)); return s ? JSON.parse(s) : {} } catch { return {} }
}
function saveStorage(driver, data) {
  try { localStorage.setItem(getStorageKey(driver), JSON.stringify(data)) } catch {}
}
function daysUntil(dateStr) {
  const due = new Date(dateStr), now = new Date()
  now.setHours(0,0,0,0); due.setHours(0,0,0,0)
  return Math.round((due - now) / (1000*60*60*24))
}
function fmt(n) { return '$' + (parseFloat(n)||0).toFixed(2) }
function uid()  { return Math.random().toString(36).slice(2,9) }

// Parse any date format that exists in this app's data into a Date at
// local noon (prevents UTC midnight rolling back a day in Central time).
// Handles: YYYY-MM-DD | MM/DD/YYYY | M/D/YYYY | MM/DD/YY. Never throws.
function parseAppDate(dateStr) {
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

// Returns true if a date string falls in a given set of months for YEAR
function inQuarter(dateStr, qMonths) {
  const d = parseAppDate(dateStr)
  if (!d) return false
  return d.getFullYear() === YEAR && qMonths.includes(d.getMonth())
}

export default function Tax({ loads, driver }) {

  const stateInfo   = STATE_RATES[driver] || STATE_RATES.TIM
  const driverColor = driver === 'BRUCE' ? '#1e88e5' : '#e53935'

  const [taxData,       setTaxData]       = useState(() => loadStorage(driver))
  const [fedRate,       setFedRate]       = useState(FED_DEFAULT)
  const [openQ,         setOpenQ]         = useState(null)
  const [menuOpen,      setMenuOpen]      = useState(false)
  const [openCatIdx,    setOpenCatIdx]    = useState(null)
  const [menuQIdx,      setMenuQIdx]      = useState(null)

  // Auto-pulled operating expense data from existing app records
  const [fuelEntries,   setFuelEntries]   = useState([])
  const [maintEntries,  setMaintEntries]  = useState([])
  const [ettrPayments,  setEttrPayments]  = useState([])
  const [expLoading,    setExpLoading]    = useState(false)
  const [expLoaded,     setExpLoaded]     = useState(false)

  // Reset local tax prefs when driver changes
  useEffect(() => {
    setTaxData(loadStorage(driver))
    setFedRate(FED_DEFAULT)
    setOpenQ(null)
    setMenuOpen(false)
    setOpenCatIdx(null)
    setMenuQIdx(null)
    setFuelEntries([])
    setMaintEntries([])
    setEttrPayments([])
    setExpLoaded(false)
  }, [driver])

  // Persist manual drop-list expenses, per diem days, and notes to localStorage
  useEffect(() => { saveStorage(driver, taxData) }, [taxData, driver])

  // Fetch fuel log and maintenance ledger when the Tax desk is rendered
  useEffect(() => {
    if (!driver || expLoaded) return
    async function fetchExpenses() {
      setExpLoading(true)
      try {
        // api() returns parsed JSON directly (or throws). Run in parallel.
        // WHITE-LABEL TODO: the escrow/payback dataset is fetched only for the
        // hardcoded driver 'TIM'. This should key off a tenant/driver setting,
        // not a fixed name.
        const tasks = [
          apiClient('/api/fuel/' + driver).catch(() => []),
          apiClient('/api/maintenance/' + driver).catch(() => []),
        ]
        if (driver === 'TIM') tasks.push(apiClient('/api/escrow-payments/TIM').catch(() => []))
        const results   = await Promise.all(tasks)
        const fuelData  = results[0]
        const maintData = results[1]
        setFuelEntries(Array.isArray(fuelData)  ? fuelData  : [])
        setMaintEntries(Array.isArray(maintData) ? maintData : [])
        if (results[2]) {
          setEttrPayments(Array.isArray(results[2]) ? results[2] : [])
        }
        setExpLoaded(true)
      } catch (err) {
        console.error('Tax: failed to fetch expenses', err)
      } finally {
        setExpLoading(false)
      }
    }
    fetchExpenses()
  }, [driver, expLoaded])

  // ── QUARTER EXPENSE HELPERS — AUTO-PULLED ──────────────
  // Fuel: ALL fuel entries (fleet + pocket) are IRS-deductible business expenses.
  function getQFuelEntries(qMonths) {
    return fuelEntries.filter(f => inQuarter(f.entry_date, qMonths))
  }
  function getQFuelTotal(qMonths) {
    return getQFuelEntries(qMonths).reduce((s, f) => s + (parseFloat(f.amount) || 0), 0)
  }
  function getQFleetFuelTotal(qMonths) {
    return getQFuelEntries(qMonths).filter(f => f.fuel_type === 'fleet').reduce((s, f) => s + (parseFloat(f.amount) || 0), 0)
  }
  function getQPocketFuelTotal(qMonths) {
    return getQFuelEntries(qMonths).filter(f => f.fuel_type === 'pocket').reduce((s, f) => s + (parseFloat(f.amount) || 0), 0)
  }

  // ACCRUAL: ALL of the driver's repairs deduct at entry_date (when incurred).
  function getQMaintEntries(qMonths) {
    return maintEntries.filter(m => inQuarter(m.entry_date, qMonths))
  }
  function isEttrFinanced(m) { return m.paid_by === 'EDGERTON' }
  function getQMaintTimTotal(qMonths) {
    return getQMaintEntries(qMonths).filter(m => !isEttrFinanced(m)).reduce((s, m) => s + (parseFloat(m.amount) || 0), 0)
  }
  function getQMaintEttrTotal(qMonths) {
    return getQMaintEntries(qMonths).filter(isEttrFinanced).reduce((s, m) => s + (parseFloat(m.amount) || 0), 0)
  }
  function getQMaintTotal(qMonths) {
    return getQMaintEntries(qMonths).reduce((s, m) => s + (parseFloat(m.amount) || 0), 0)
  }

  // Financed repair payback: deducted nowhere (debt service). Shown informational.
  function getQEttrPayments(qMonths) {
    return ettrPayments.filter(p => inQuarter(p.funded_at, qMonths))
  }
  function getQEttrTotal(qMonths) {
    return getQEttrPayments(qMonths).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0)
  }

  // ── MANUAL DROP-LIST EXPENSE HELPERS ───────────────────
  function getQKey(qIdx)   { return YEAR + '_Q' + (qIdx + 1) }
  function getQData(qIdx)  { return taxData[getQKey(qIdx)] || {} }

  function updateQData(qIdx, field, value) {
    const key = getQKey(qIdx)
    setTaxData(prev => ({ ...prev, [key]: { ...(prev[key]||{}), [field]: value } }))
  }

  function togglePaid(qIdx) {
    const key = getQKey(qIdx)
    setTaxData(prev => ({
      ...prev,
      [key]: { ...(prev[key]||{}), paid: !((prev[key] || {}).paid) }
    }))
  }

  function getDropEntries(qIdx) {
    return (getQData(qIdx)).drop_expenses || []
  }

  function addDropEntry(qIdx, label) {
    const key      = getQKey(qIdx)
    const newEntry = { id: uid(), label, amount: '' }
    setTaxData(prev => {
      const existing = (prev[key] || {}).drop_expenses || []
      return { ...prev, [key]: { ...(prev[key]||{}), drop_expenses: [...existing, newEntry] } }
    })
    setMenuOpen(false)
    setOpenCatIdx(null)
    setMenuQIdx(null)
  }

  function updateDropEntry(qIdx, id, amount) {
    const key = getQKey(qIdx)
    setTaxData(prev => {
      const existing = (prev[key] || {}).drop_expenses || []
      return {
        ...prev,
        [key]: { ...(prev[key]||{}), drop_expenses: existing.map(e => e.id === id ? { ...e, amount } : e) }
      }
    })
  }

  function removeDropEntry(qIdx, id) {
    const key = getQKey(qIdx)
    setTaxData(prev => {
      const existing = (prev[key] || {}).drop_expenses || []
      return {
        ...prev,
        [key]: { ...(prev[key]||{}), drop_expenses: existing.filter(e => e.id !== id) }
      }
    })
  }

  // ── PER DIEM — DAY COUNTS ──────────────────────────────
  function getPerDiemDays(qIdx) {
    const q = getQData(qIdx)
    return {
      full: parseFloat(q.perdiem_full) || 0,
      half: parseFloat(q.perdiem_half) || 0,
    }
  }

  function getPerDiemDeduction(qIdx) {
    const { full, half } = getPerDiemDays(qIdx)
    return (full * PER_DIEM_FULL + half * PER_DIEM_HALF) * PER_DIEM_DEDUCTIBLE
  }

  // ── REVENUE — auto-pulled from loads by DELIVERY DATE ──
  function getQuarterRevenue(qMonths) {
    return loads
      .filter(l => {
        if (l.driver !== driver) return false
        const dateStr = l.delivery_date || l.date || l.created_at
        return inQuarter(dateStr, qMonths)
      })
      .reduce((sum, l) => sum + (parseFloat(l.net_pay || l.netPay) || 0), 0)
  }

  // Total expenses: auto fuel + auto repairs + per diem days + manual drop-list
  function getExpenseTotal(qIdx) {
    const q           = QUARTERS[qIdx]
    const autoFuel    = getQFuelTotal(q.months)
    const autoRepair  = getQMaintTotal(q.months)
    const perDiem     = getPerDiemDeduction(qIdx)
    const manualDrop  = getDropEntries(qIdx).reduce((s,e) => s+(parseFloat(e.amount)||0), 0)
    return autoFuel + autoRepair + perDiem + manualDrop
  }

  function calcTax(revenue, expenses) {
    const netIncome = Math.max(0, revenue - expenses)
    const fedTax    = netIncome * (fedRate / 100)
    const stateTax  = netIncome * stateInfo.rate
    return { netIncome, fedTax, stateTax, totalTax: fedTax + stateTax }
  }

  const grandTotals = QUARTERS.reduce((acc, q, i) => {
    const revenue  = getQuarterRevenue(q.months)
    const expenses = getExpenseTotal(i)
    const { totalTax } = calcTax(revenue, expenses)
    acc.revenue  += revenue
    acc.expenses += expenses
    acc.tax      += totalTax
    acc.paid     += (getQData(i)).paid ? totalTax : 0
    return acc
  }, { revenue:0, expenses:0, tax:0, paid:0 })

  // ── SHARED STYLES ──────────────────────────────────────
  const autoBox = {
    background:'var(--navy3)', borderRadius:8, padding:'10px 12px', marginBottom:12,
  }
  const autoLabel = {
    fontSize:10, color:'var(--grey)', fontFamily:'var(--font-head)',
    letterSpacing:'0.08em', marginBottom:6, textTransform:'uppercase',
  }
  const dayInputStyle = {
    width:'100%', background:'var(--navy2)', border:'1px solid var(--border)',
    color:'var(--white)', borderRadius:8, padding:'10px 12px',
    fontSize:20, fontWeight:700, fontFamily:'var(--font-head)',
    boxSizing:'border-box', textAlign:'center',
  }

  return (
    <div style={{ paddingBottom:16 }}>

      {/* HEADER CARD */}
      <div className="card" style={{ borderLeft:'3px solid '+driverColor, marginBottom:14 }}>
        <div style={{ fontFamily:'var(--font-head)', fontWeight:900, fontSize:15, color:driverColor, marginBottom:10, letterSpacing:'0.05em' }}>
          {driver}'S TAX DESK - {YEAR}
        </div>
        <div style={{ fontSize:11, color:'var(--grey)', marginBottom:10 }}>
          {stateInfo.label} resident - state rate {stateInfo.default}%
        </div>
        {expLoading && (
          <div style={{ fontSize:11, color:'var(--amber)', fontFamily:'var(--font-head)', marginBottom:8 }}>
            Loading expense data...
          </div>
        )}
        <div className="amount-row"><span className="label">Total Revenue</span><span className="value" style={{color:'var(--amber)'}}>{fmt(grandTotals.revenue)}</span></div>
        <div className="amount-row"><span className="label">Total Expenses</span><span className="value" style={{color:'var(--grey)'}}>-{fmt(grandTotals.expenses)}</span></div>
        <div className="amount-row"><span className="label">Est. Tax Owed (All Quarters)</span><span className="value" style={{color:'#e53935'}}>{fmt(grandTotals.tax)}</span></div>
        <div className="amount-row"><span className="label">Quarterly Payments Made</span><span className="value" style={{color:'var(--green)'}}>{fmt(grandTotals.paid)}</span></div>
        <div className="net-total" style={{marginTop:12}}>
          <span className="label">REMAINING BALANCE</span>
          <span className="value" style={{color: grandTotals.tax - grandTotals.paid > 0 ? '#e53935' : 'var(--green)'}}>
            {fmt(Math.max(0, grandTotals.tax - grandTotals.paid))}
          </span>
        </div>
      </div>

      {/* FEDERAL RATE ADJUSTER */}
      <div className="card" style={{marginBottom:14}}>
        <div className="section-title" style={{marginBottom:8}}>FEDERAL TAX BRACKET</div>
        <div style={{display:'flex', alignItems:'center', gap:12}}>
          <input type="range" min={10} max={32} step={1} value={fedRate}
            onChange={e => setFedRate(Number(e.target.value))}
            style={{flex:1, accentColor:'var(--amber)'}} />
          <div style={{fontFamily:'var(--font-head)', fontWeight:900, fontSize:20, color:'var(--amber)', minWidth:48, textAlign:'right'}}>{fedRate}%</div>
        </div>
        <div style={{fontSize:11, color:'var(--grey)', marginTop:6}}>
          Federal {fedRate}% + {stateInfo.label} {stateInfo.default}% - Estimated Tax
        </div>
      </div>

      {/* QUARTER CARDS */}
      {QUARTERS.map((q, qIdx) => {
        const revenue     = getQuarterRevenue(q.months)
        const expenses    = getExpenseTotal(qIdx)
        const { netIncome, fedTax, stateTax, totalTax } = calcTax(revenue, expenses)
        const days        = daysUntil(q.due)
        const isPaid      = (getQData(qIdx)).paid || false
        const isOpen      = openQ === qIdx
        const dropEntries = getDropEntries(qIdx)
        const isMenuOpen  = menuOpen && menuQIdx === qIdx

        // Auto-pulled quarter data
        const qFleet   = getQFleetFuelTotal(q.months)
        const qPocket  = getQPocketFuelTotal(q.months)
        const qFuel    = qFleet + qPocket
        const qRepairs = getQMaintTotal(q.months)
        const qEttr    = getQEttrTotal(q.months)
        const qFuelCount   = getQFuelEntries(q.months).length
        const qRepairCount = getQMaintEntries(q.months).length
        const qEttrCount   = getQEttrPayments(q.months).length

        // Per diem
        const pd          = getPerDiemDays(qIdx)
        const pdDeduction = getPerDiemDeduction(qIdx)

        let countdownColor = 'var(--green)'
        let countdownText  = days + ' days away'
        if (days < 0)                { countdownColor='var(--grey)';  countdownText='Past due' }
        if (days >= 0 && days <= 14) { countdownColor='#e53935';      countdownText=days+' days - ACT NOW' }
        if (days > 14 && days <= 30) { countdownColor='var(--amber)'; countdownText=days+' days away' }

        return (
          <div key={qIdx} className="card" style={{borderLeft:'3px solid '+q.color, marginBottom:12}}>

            {/* Quarter header */}
            <div
              style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', cursor:'pointer'}}
              onClick={() => setOpenQ(isOpen ? null : qIdx)}
            >
              <div>
                <div style={{fontFamily:'var(--font-head)', fontWeight:900, fontSize:15, color:q.color, letterSpacing:'0.05em'}}>
                  {q.label} - {q.title}
                </div>
                <div style={{fontSize:11, color:'var(--grey)', marginTop:3}}>Due: {q.dueLabel}</div>
                <div style={{fontSize:11, color:countdownColor, marginTop:2, fontWeight:700}}>
                  {isPaid ? 'PAYMENT MADE' : countdownText}
                </div>
              </div>
              <div style={{textAlign:'right'}}>
                <div style={{fontFamily:'var(--font-head)', fontSize:22, fontWeight:900, color: isPaid ? 'var(--green)' : '#e53935'}}>
                  {fmt(totalTax)}
                </div>
                <div style={{fontSize:10, color:'var(--grey)', marginTop:2}}>estimated tax</div>
                <div style={{fontSize:12, color:'var(--grey)', marginTop:4}}>{isOpen ? '▲' : '▼'}</div>
              </div>
            </div>

            {/* Expanded quarter body — stopPropagation prevents header toggle on inner taps */}
            {isOpen && (
              <div style={{marginTop:14}} onClick={e => e.stopPropagation()}>

                {/* REVENUE — auto-pulled from loads */}
                <div style={autoBox}>
                  <div style={autoLabel}>Auto-Pulled - Revenue from Loads (by delivery date)</div>
                  <div className="amount-row" style={{marginBottom:0}}>
                    <span className="label">Gross Revenue</span>
                    <span className="value" style={{color:'var(--amber)'}}>{fmt(revenue)}</span>
                  </div>
                  {revenue === 0 && (
                    <div style={{fontSize:11, color:'var(--grey)', marginTop:6}}>
                      No {driver} loads delivered in this quarter
                    </div>
                  )}
                </div>

                {/* FUEL — auto-pulled from fuel log */}
                <div style={autoBox}>
                  <div style={autoLabel}>
                    Auto-Pulled - Fuel Log ({qFuelCount} {qFuelCount === 1 ? 'entry' : 'entries'})
                  </div>
                  {qFuelCount === 0 ? (
                    <div style={{fontSize:11, color:'var(--grey)'}}>
                      No fuel entries in this quarter
                    </div>
                  ) : (
                    <>
                      {qFleet > 0 && (
                        <div className="amount-row" style={{marginBottom:4}}>
                          <span className="label" style={{color:'var(--amber)'}}>Fleet Card Fuel</span>
                          <span className="value" style={{color:'var(--amber)'}}>{fmt(qFleet)}</span>
                        </div>
                      )}
                      {qPocket > 0 && (
                        <div className="amount-row" style={{marginBottom:4}}>
                          <span className="label" style={{color:'#64b5f6'}}>Out of Pocket Fuel</span>
                          <span className="value" style={{color:'#64b5f6'}}>{fmt(qPocket)}</span>
                        </div>
                      )}
                      <div style={{borderTop:'1px solid var(--border)', paddingTop:6, marginTop:4}}>
                        <div className="amount-row" style={{marginBottom:0}}>
                          <span className="label" style={{fontWeight:700}}>Total Fuel Deduction</span>
                          <span className="value" style={{color:'var(--green)', fontWeight:700}}>{fmt(qFuel)}</span>
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {/* REPAIRS — auto-pulled from maintenance ledger (ALL entries, accrual at entry_date) */}
                <div style={autoBox}>
                  <div style={autoLabel}>
                    Auto-Pulled - Repairs &amp; Maintenance ({qRepairCount} {qRepairCount === 1 ? 'entry' : 'entries'})
                  </div>
                  {qRepairCount === 0 ? (
                    <div style={{fontSize:11, color:'var(--grey)'}}>
                      No repairs in this quarter
                    </div>
                  ) : (
                    <>
                      {getQMaintEntries(q.months).map((m, i) => (
                        <div key={m.id || i} className="amount-row" style={{marginBottom:4}}>
                          <span className="label" style={{fontSize:11}}>{m.description || m.category || 'Repair'}{isEttrFinanced(m) ? ' — financed' : ''}</span>
                          <span className="value" style={{color:'var(--green)'}}>{fmt(m.amount)}</span>
                        </div>
                      ))}
                      <div style={{borderTop:'1px solid var(--border)', paddingTop:6, marginTop:4}}>
                        <div className="amount-row" style={{marginBottom:0}}>
                          <span className="label" style={{fontWeight:700}}>Total Repair Deduction</span>
                          <span className="value" style={{color:'var(--green)', fontWeight:700}}>{fmt(qRepairs)}</span>
                        </div>
                      </div>
                      {getQMaintEttrTotal(q.months) > 0 && (
                        <div style={{fontSize:10, color:'var(--grey)', marginTop:6}}>
                          Driver paid {fmt(getQMaintTimTotal(q.months))} · financed (terms) {fmt(getQMaintEttrTotal(q.months))}. Financed repairs deduct when incurred; payback is debt service.
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* FINANCED REPAIR PAYMENTS — informational only: debt service, NOT a deduction */}
                {driver === 'TIM' && (
                  <div style={autoBox}>
                    <div style={autoLabel}>
                      Info - Repair Payback — not a deduction ({qEttrCount} {qEttrCount === 1 ? 'payment' : 'payments'})
                    </div>
                    {qEttrCount === 0 ? (
                      <div style={{fontSize:11, color:'var(--grey)'}}>
                        No repair payments in this quarter
                      </div>
                    ) : (
                      <>
                        {getQEttrPayments(q.months).map((p, i) => (
                          <div key={p.id || i} className="amount-row" style={{marginBottom:4}}>
                            <span className="label" style={{fontSize:11}}>Payment — {(p.funded_at || '').substring(0,10)}</span>
                            <span className="value" style={{color:'var(--grey)'}}>{fmt(p.amount)}</span>
                          </div>
                        ))}
                        <div style={{borderTop:'1px solid var(--border)', paddingTop:6, marginTop:4}}>
                          <div className="amount-row" style={{marginBottom:0}}>
                            <span className="label" style={{fontWeight:700}}>Total Paid — Debt Service</span>
                            <span className="value" style={{color:'var(--grey)', fontWeight:700}}>{fmt(qEttr)}</span>
                          </div>
                        </div>
                        <div style={{fontSize:10, color:'var(--grey)', marginTop:6}}>
                          Payback of financed repairs. NOT a deduction — those repairs already deducted in the quarter incurred.
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* PER DIEM — day counts */}
                <div style={autoBox}>
                  <div style={autoLabel}>
                    Per Diem - Days Away From Home
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:8 }}>
                    <div>
                      <div style={{ fontSize:10, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:4, letterSpacing:'0.04em' }}>
                        FULL DAYS (${PER_DIEM_FULL})
                      </div>
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        placeholder="0"
                        value={(getQData(qIdx)).perdiem_full || ''}
                        onChange={e => updateQData(qIdx, 'perdiem_full', e.target.value)}
                        style={dayInputStyle}
                      />
                    </div>
                    <div>
                      <div style={{ fontSize:10, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:4, letterSpacing:'0.04em' }}>
                        HALF DAYS (${PER_DIEM_HALF})
                      </div>
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        placeholder="0"
                        value={(getQData(qIdx)).perdiem_half || ''}
                        onChange={e => updateQData(qIdx, 'perdiem_half', e.target.value)}
                        style={dayInputStyle}
                      />
                    </div>
                  </div>
                  <div style={{ fontSize:10, color:'var(--grey)', marginBottom: pdDeduction > 0 ? 8 : 0 }}>
                    Home by 12:00 PM = half day. After 12:01 PM = full day. 80% deductible.
                  </div>
                  {pdDeduction > 0 && (
                    <div style={{borderTop:'1px solid var(--border)', paddingTop:6}}>
                      <div className="amount-row" style={{marginBottom:0}}>
                        <span className="label" style={{fontWeight:700}}>
                          Per Diem Deduction ({pd.full} full{pd.half > 0 ? ', ' + pd.half + ' half' : ''})
                        </span>
                        <span className="value" style={{color:'var(--green)', fontWeight:700}}>{fmt(pdDeduction)}</span>
                      </div>
                    </div>
                  )}
                </div>

                <div style={{borderTop:'1px solid var(--border)', margin:'12px 0'}} />

                {/* MANUAL ADDITIONAL EXPENSES from drop list */}
                {dropEntries.length > 0 && (
                  <div style={{marginBottom:12}}>
                    <div style={{fontSize:11, color:'var(--white)', fontFamily:'var(--font-head)', fontWeight:700, letterSpacing:'0.06em', marginBottom:8}}>
                      ADDITIONAL EXPENSES
                    </div>
                    {dropEntries.map(e => (
                      <div key={e.id} style={{marginBottom:8}}>
                        <div style={{fontSize:11, color:'var(--grey)', marginBottom:4}}>{e.label}</div>
                        <div style={{display:'flex', alignItems:'center', gap:8}}>
                          <span style={{fontSize:12, color:'var(--grey)', minWidth:16}}>$</span>
                          <input
                            type="text"
                            inputMode="decimal"
                            pattern="[0-9]*\.?[0-9]*"
                            placeholder="0.00"
                            value={e.amount}
                            onChange={ev => updateDropEntry(qIdx, e.id, ev.target.value)}
                            style={{flex:1, background:'var(--navy3)', border:'1px solid var(--border)', color:'var(--white)', borderRadius:8, padding:'8px 10px', fontSize:14, fontFamily:'var(--font-body)'}}
                          />
                          <button
                            onClick={(ev) => { ev.stopPropagation(); removeDropEntry(qIdx, e.id) }}
                            style={{padding:'6px 10px', borderRadius:6, border:'none', background:'#3a1010', color:'#e53935', fontSize:13, fontWeight:900, cursor:'pointer'}}
                          >x</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* ADD EXPENSE FROM LIST */}
                <div style={{position:'relative', marginBottom:16}}>
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation()
                      if (isMenuOpen) { setMenuOpen(false); setMenuQIdx(null); setOpenCatIdx(null) }
                      else            { setMenuOpen(true);  setMenuQIdx(qIdx); setOpenCatIdx(null) }
                    }}
                    style={{
                      width:'100%', padding:'11px 0', borderRadius:8,
                      border:'1px solid var(--amber)', background:'transparent',
                      color:'var(--amber)', fontSize:13,
                      fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer',
                    }}
                  >
                    + ADD EXPENSE FROM LIST {isMenuOpen ? '▲' : '▼'}
                  </button>

                  {isMenuOpen && (
                    <div style={{
                      position:'absolute', top:'calc(100% + 6px)', left:0, right:0,
                      background:'var(--navy2)', border:'1px solid var(--border)',
                      borderRadius:10, zIndex:100,
                      boxShadow:'0 8px 24px rgba(0,0,0,0.5)',
                      maxHeight:360, overflowY:'auto',
                    }}>
                      {EXPENSE_CATEGORIES.map((cat, catIdx) => (
                        <div key={catIdx}>
                          <div
                            onClick={(ev) => { ev.stopPropagation(); setOpenCatIdx(openCatIdx === catIdx ? null : catIdx) }}
                            style={{
                              display:'flex', justifyContent:'space-between', alignItems:'center',
                              padding:'13px 16px', cursor:'pointer',
                              background: openCatIdx === catIdx ? 'var(--navy3)' : 'transparent',
                              borderBottom:'1px solid var(--border)',
                            }}
                          >
                            <span style={{fontSize:13, color:'var(--white)', fontFamily:'var(--font-head)', fontWeight:700}}>
                              {cat.label}
                            </span>
                            <span style={{fontSize:12, color:'var(--grey)'}}>{openCatIdx === catIdx ? '▲' : '▼'}</span>
                          </div>
                          {openCatIdx === catIdx && (
                            <div style={{background:'var(--navy3)'}}>
                              {cat.items.map((item, itemIdx) => (
                                <div
                                  key={itemIdx}
                                  onClick={(ev) => { ev.stopPropagation(); addDropEntry(qIdx, item) }}
                                  style={{
                                    padding:'11px 24px', fontSize:13,
                                    color:'var(--grey)', fontFamily:'var(--font-body)',
                                    borderBottom:'1px solid rgba(255,255,255,0.05)',
                                    cursor:'pointer',
                                  }}
                                >
                                  {item}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* TAX BREAKDOWN */}
                <div style={{background:'var(--navy3)', borderRadius:8, padding:'10px 12px', marginBottom:12}}>
                  <div style={{fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:8}}>TAX BREAKDOWN</div>
                  <div className="amount-row"><span className="label">Gross Revenue</span><span className="value">{fmt(revenue)}</span></div>
                  {qFuel > 0 && (
                    <div className="amount-row"><span className="label" style={{color:'var(--grey)'}}>- Fuel (auto)</span><span className="value" style={{color:'var(--grey)'}}>({fmt(qFuel)})</span></div>
                  )}
                  {qRepairs > 0 && (
                    <div className="amount-row"><span className="label" style={{color:'var(--grey)'}}>- Repairs (auto)</span><span className="value" style={{color:'var(--grey)'}}>({fmt(qRepairs)})</span></div>
                  )}
                  {pdDeduction > 0 && (
                    <div className="amount-row"><span className="label" style={{color:'var(--grey)'}}>- Per Diem ({pd.full} full{pd.half > 0 ? ', ' + pd.half + ' half' : ''})</span><span className="value" style={{color:'var(--grey)'}}>({fmt(pdDeduction)})</span></div>
                  )}
                  {getDropEntries(qIdx).reduce((s,e) => s+(parseFloat(e.amount)||0),0) > 0 && (
                    <div className="amount-row"><span className="label" style={{color:'var(--grey)'}}>- Other Expenses</span><span className="value" style={{color:'var(--grey)'}}>({fmt(getDropEntries(qIdx).reduce((s,e) => s+(parseFloat(e.amount)||0),0))})</span></div>
                  )}
                  <div className="amount-row"><span className="label">Total Deductions</span><span className="value" style={{color:'var(--grey)'}}>-{fmt(expenses)}</span></div>
                  <div className="amount-row" style={{borderTop:'1px solid var(--border)', paddingTop:8, marginTop:4}}>
                    <span className="label">Net Taxable Income</span>
                    <span className="value" style={{color:'var(--white)'}}>{fmt(netIncome)}</span>
                  </div>
                  <div className="amount-row" style={{marginTop:8}}>
                    <span className="label">Federal ({fedRate}%)</span>
                    <span className="value" style={{color:'#e53935'}}>{fmt(fedTax)}</span>
                  </div>
                  <div className="amount-row">
                    <span className="label">{stateInfo.label} ({stateInfo.default}%)</span>
                    <span className="value" style={{color:'#e53935'}}>{fmt(stateTax)}</span>
                  </div>
                  <div className="net-total" style={{marginTop:10}}>
                    <span className="label">ESTIMATED TAX DUE</span>
                    <span className="value" style={{color:'#e53935'}}>{fmt(totalTax)}</span>
                  </div>
                </div>

                {/* NOTES */}
                <div className="field-row" style={{marginBottom:12}}>
                  <div className="field-label">Notes</div>
                  <textarea
                    value={(getQData(qIdx)).notes || ''}
                    onChange={e => updateQData(qIdx, 'notes', e.target.value)}
                    placeholder="Payment confirmation, reference number..."
                    style={{width:'100%', minHeight:56, background:'var(--navy3)', border:'1px solid var(--border)', color:'var(--white)', borderRadius:8, padding:'10px 12px', fontSize:14, fontFamily:'var(--font-body)', resize:'vertical'}}
                  />
                </div>

                {/* MARK PAYMENT */}
                <button
                  className={isPaid ? 'scan-btn secondary' : 'scan-btn success'}
                  style={{width:'100%'}}
                  onClick={(ev) => { ev.stopPropagation(); togglePaid(qIdx) }}
                >
                  {isPaid ? 'UNMARK PAYMENT' : 'MARK PAYMENT MADE - ' + fmt(totalTax)}
                </button>

              </div>
            )}
          </div>
        )
      })}

      <div style={{textAlign:'center', fontSize:11, color:'var(--grey)', marginTop:8, padding:'0 16px'}}>
        Estimated Tax - Form 1040-ES | Schedule C | IRS.gov
      </div>

    </div>
  )
}
