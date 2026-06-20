// src/DriverPaystub.jsx
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledgers V5 — DRIVER PAYSTUB (weekly settlement, driver-facing).
//
// WHAT THIS IS
//   A read-only driver pay stub for one settlement week, built from data that
//   already exists (loads, fuel_entries, carrier_advances, recurring_charges).
//   It reuses the SAME math as settlementMath.js so the numbers tie to billing
//   — this view never writes anything and never changes the running balance. It
//   cannot break billing; it only reads and arranges.
//
// PRESENTATION: a pay document, not a dashboard. ALL fonts are plain black.
//   No red/amber/green. Deductions are shown with a leading minus sign, not
//   color. The net line is black bold.
//
// SETTLEMENT WEEK
//   Monday -> Monday, cutoff end of day Monday. A load counts in the week that
//   its anchor date falls into; PAID on that closing Monday. Anchor date today
//   is the load's billed/delivery date (loadDate from settlementMath).
//
// RECURRING CHARGES (2026-06-20): insurance, plate (IRP) installments, and
//   payment plans now render as REAL deduction lines, replacing the old
//   "coming next" placeholder. Each active recurring_charges row is sliced to
//   this settlement week by settlementMath.recurringChargesForWeek (monthly
//   charges are pro-rated to a weekly amount; the start/end date window is
//   applied against the week's pay date). The italic placeholder shows ONLY
//   when this driver has no recurring charges configured yet.
//
// SCROLL / OVERLAY POSITIONING (2026-06-20, v4 — THE REAL FIX):
//   The previous versions rendered this fixed overlay INSIDE App's
//   `.tab-content`, which is an `overflow-y:auto` + `-webkit-overflow-scrolling:
//   touch` scroll container. On iOS WebKit, a position:fixed element nested
//   inside such a scroller is CLIPPED to that scroller's box instead of the
//   viewport — so the overlay sat between the app header and the tab bar, its
//   own top (DRIVER SETTLEMENT / week navigator) pushed out of view, and it
//   sprang back when released. No amount of internal flex/scroll tuning could
//   fix it because the container itself was clipping us.
//   FIX: render the overlay through a React portal into document.body, so it is
//   NOT a descendant of `.tab-content` and position:fixed anchors to the real
//   viewport. Inside, it's a fixed non-scrolling flex column: a header row that
//   never moves + one scrollable body beneath it. Native scroll only.

import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { api as apiClient } from './api.js'
import {
  normalizeOwnerCut, parseAppDate, loadDate, calcPay, recurringChargesForWeek,
} from './settlementMath'

function fmt(n) { return '$' + (parseFloat(n) || 0).toFixed(2) }

// -- SETTLEMENT WEEK MATH (Monday -> Monday, cutoff end of Monday) ------------
function settlementWeek(offset) {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0)
  const dow = d.getDay()
  const daysUntilMon = (1 - dow + 7) % 7
  const closingMon = new Date(d)
  closingMon.setDate(d.getDate() + daysUntilMon)
  closingMon.setDate(closingMon.getDate() + offset * 7)
  const end = new Date(closingMon.getFullYear(), closingMon.getMonth(), closingMon.getDate(), 23, 59, 59, 999)
  const start = new Date(end)
  start.setDate(end.getDate() - 6)
  start.setHours(0, 0, 0, 0)
  const label =
    start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase() +
    ' - ' +
    end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase()
  return { start, end, payDate: end, label }
}

function weekAnchorDate(load) {
  return parseAppDate(loadDate(load))
}

function inWeek(dateObj, week) {
  if (!dateObj) return false
  return dateObj >= week.start && dateObj <= week.end
}

export default function DriverPaystub({ driverName, loads, ownerCutPct = 10, color = '#1e88e5', onClose }) {
  const [weekOffset, setWeekOffset] = useState(0)
  const [fuelEntries, setFuelEntries] = useState([])
  const [carrierAdvances, setCarrierAdvances] = useState([])
  const [recurringCharges, setRecurringCharges] = useState([])
  const [loading, setLoading] = useState(true)

  // Pull this driver's fuel + advances + recurring charges once (read-only).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [fuel, adv, recur] = await Promise.all([
          apiClient('/api/fuel/' + driverName).catch(() => []),
          apiClient('/api/carrier-advances/' + driverName).catch(() => []),
          apiClient('/api/recurring-charges/' + driverName).catch(() => []),
        ])
        if (cancelled) return
        setFuelEntries(Array.isArray(fuel) ? fuel : [])
        setCarrierAdvances(Array.isArray(adv) ? adv : [])
        setRecurringCharges(Array.isArray(recur) ? recur : [])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [driverName])

  // Lock the page body scroll while the overlay is open, and restore on close.
  // Belt-and-suspenders with the portal: the overlay owns the screen.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const week = useMemo(() => settlementWeek(weekOffset), [weekOffset])
  const cut = normalizeOwnerCut(ownerCutPct)

  // -- DRIVER PAY: loads that fall in this settlement week --------------------
  const stub = useMemo(() => {
    const dLoads = (Array.isArray(loads) ? loads : []).filter(l => l.driver === driverName)
    const weekLoads = dLoads.filter(l => inWeek(weekAnchorDate(l), week))

    const payRows = weekLoads.map(l => {
      const loadTotal = parseFloat(l.net_pay) || parseFloat(l.base_pay) || 0
      const base      = parseFloat(l.base_pay) || 0
      const driverBase = l.is_owner_operator ? base : base * (1 - cut)
      const fuelSur   = parseFloat(l.fuel) || 0
      const detention = parseFloat(l.detention) || 0
      return {
        loadNum: l.load_number || '-',
        broker: l.broker_name || '',
        loadTotal,
        driverBase,
        fuelSur,
        detention,
        lineTotal: driverBase + fuelSur + detention,
        isAch: !!l.ach_payment,
      }
    })

    const driverGross = payRows.reduce((s, r) => s + r.lineTotal, 0)

    const fleetFuelRows = fuelEntries
      .filter(f => (f.driver || '').toUpperCase() === driverName.toUpperCase()
        && f.fuel_type === 'fleet'
        && inWeek(parseAppDate(f.entry_date), week))
      .map(f => ({ label: 'Fleet Fuel Card', date: f.entry_date, note: f.notes || '', amount: parseFloat(f.amount) || 0 }))
    const fleetFuelTotal = fleetFuelRows.reduce((s, r) => s + r.amount, 0)

    const advanceRows = carrierAdvances
      .filter(a => (a.driver || '').toUpperCase() === driverName.toUpperCase() && !a.repaid)
      .map(a => ({
        label: 'Advance' + (a.reason ? ' (' + a.reason + ')' : ''),
        ref: a.notes || a.advance_date || '',
        amount: parseFloat(a.amount) || 0,
      }))
    const advanceTotal = advanceRows.reduce((s, r) => s + r.amount, 0)

    // RECURRING CHARGES — insurance / plates / payment plans, sliced to this
    // week by the shared settlement math (monthly charges pro-rated to weekly,
    // start/end window judged on the week's pay date). `hasRecurring` tells the
    // UI whether to show the live lines or the "coming next" placeholder.
    const recurring = recurringChargesForWeek(recurringCharges, driverName, week.payDate)
    const recurringRows = recurring.rows
    const recurringTotal = recurring.total
    const hasRecurring = (Array.isArray(recurringCharges) ? recurringCharges : [])
      .some(c => (c.driver || '').toUpperCase() === driverName.toUpperCase())

    const totalDeductions = fleetFuelTotal + advanceTotal + recurringTotal
    const netPay = driverGross - totalDeductions

    return {
      payRows, driverGross,
      fleetFuelRows, fleetFuelTotal,
      advanceRows, advanceTotal,
      recurringRows, recurringTotal, hasRecurring,
      totalDeductions, netPay,
    }
  }, [loads, driverName, week, cut, fuelEntries, carrierAdvances, recurringCharges])

  // -- STYLES (paystub look: white sheet, plain BLACK text throughout) -------
  const INK = '#111'
  const MUTE = '#555'
  // Fixed, full-viewport, NON-scrolling flex column. Rendered via portal into
  // document.body (see return) so it escapes the app's scroll container.
  const sheet = { position:'fixed', top:0, left:0, right:0, bottom:0, background:'#fff', zIndex:100000, display:'flex', flexDirection:'column' }
  const bar   = { flex:'0 0 auto', background:'#fff', borderBottom:'2px solid #111', padding:'calc(env(safe-area-inset-top, 0px) + 12px) 16px 12px', display:'flex', alignItems:'center', justifyContent:'space-between' }
  const scroller = { flex:'1 1 auto', overflowY:'auto', WebkitOverflowScrolling:'touch', overscrollBehavior:'contain', paddingBottom:'env(safe-area-inset-bottom, 0px)' }
  const wrap  = { padding:16, maxWidth:620, margin:'0 auto', color:INK }
  const sect  = { fontSize:12, fontWeight:900, color:INK, fontFamily:'var(--font-head)', letterSpacing:'0.08em', margin:'18px 0 6px', paddingLeft:2 }
  const card  = { borderRadius:6, border:'1px solid #bbb', overflow:'hidden' }
  const row   = { display:'flex', justifyContent:'space-between', alignItems:'baseline', padding:'10px 12px', borderBottom:'1px solid #e2e2e2', fontSize:13, color:INK }
  const sub   = { ...row, padding:'6px 12px 6px 28px', fontSize:12, color:INK, borderBottom:'1px solid #eee' }
  const rightAmt = { fontFamily:'var(--font-head)', fontWeight:700, color:INK }
  const totalRow = { display:'flex', justifyContent:'space-between', alignItems:'baseline', padding:'12px', background:'#f2f2f2', fontWeight:800, fontSize:14, color:INK, fontFamily:'var(--font-head)' }

  const overlay = (
    <div style={sheet}>
      <div style={bar}>
        <div>
          <div style={{ fontSize:11, color:MUTE, fontFamily:'var(--font-head)', letterSpacing:'0.08em' }}>DRIVER SETTLEMENT</div>
          <div style={{ fontSize:16, fontFamily:'var(--font-head)', fontWeight:900, color:INK }}>{driverName}</div>
        </div>
        <button onClick={onClose} style={{ background:'#111', border:'none', color:'#fff', borderRadius:6, padding:'8px 16px', fontSize:14, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }}>X CLOSE</button>
      </div>

      <div style={scroller}>
      <div style={wrap}>
        {/* WEEK NAVIGATOR */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', margin:'4px 0 12px' }}>
          <button onClick={() => setWeekOffset(o => o - 1)} style={{ padding:'6px 16px', borderRadius:6, border:'1px solid #999', background:'#fff', color:INK, fontSize:20, fontFamily:'var(--font-head)', cursor:'pointer', lineHeight:1 }}>&#8249;</button>
          <div style={{ textAlign:'center' }}>
            <div style={{ fontSize:11, color:MUTE, fontFamily:'var(--font-head)', letterSpacing:'0.06em' }}>SETTLEMENT WEEK (PAID {week.payDate.toLocaleDateString('en-US',{ month:'short', day:'numeric' }).toUpperCase()})</div>
            <div style={{ fontSize:14, color:INK, fontFamily:'var(--font-head)', fontWeight:900, letterSpacing:'0.04em' }}>{week.label}</div>
          </div>
          <button disabled={weekOffset >= 0} onClick={() => setWeekOffset(o => o + 1)} style={{ padding:'6px 16px', borderRadius:6, border:'1px solid #999', background:'#fff', color:INK, fontSize:20, fontFamily:'var(--font-head)', cursor:'pointer', lineHeight:1, opacity: weekOffset >= 0 ? 0.3 : 1 }}>&#8250;</button>
        </div>

        {loading && <div style={{ textAlign:'center', color:MUTE, padding:'30px 0', fontFamily:'var(--font-head)' }}>Loading settlement...</div>}

        {!loading && (
          <>
            {/* DRIVER PAY */}
            <div style={sect}>DRIVER PAY</div>
            <div style={card}>
              {stub.payRows.length === 0 && (
                <div style={{ ...row, color:MUTE, justifyContent:'center' }}>No loads billed in this week.</div>
              )}
              {stub.payRows.map((r, i) => (
                <div key={i}>
                  <div style={row}>
                    <div>
                      <strong>Load #{r.loadNum}</strong>
                      {r.isAch && <span style={{ marginLeft:6, fontSize:9, border:'1px solid #111', color:INK, padding:'1px 5px', borderRadius:3, fontWeight:700 }}>ACH</span>}
                      <div style={{ fontSize:11, color:MUTE }}>{r.broker}</div>
                      <div style={{ fontSize:11, color:MUTE }}>Load total {fmt(r.loadTotal)}</div>
                    </div>
                    <div style={rightAmt}>{fmt(r.driverBase)}</div>
                  </div>
                  {r.fuelSur > 0 && (
                    <div style={sub}><span>Fuel Surcharge</span><span style={rightAmt}>{fmt(r.fuelSur)}</span></div>
                  )}
                  {r.detention > 0 && (
                    <div style={sub}><span>Detention / Extra Pay</span><span style={rightAmt}>{fmt(r.detention)}</span></div>
                  )}
                </div>
              ))}
              <div style={totalRow}><span>DRIVER GROSS PAY</span><span>{fmt(stub.driverGross)}</span></div>
            </div>

            {/* CARRIER DEDUCTIONS */}
            <div style={sect}>CARRIER DEDUCTIONS</div>
            <div style={card}>
              {stub.fleetFuelRows.map((r, i) => (
                <div key={'f'+i} style={row}>
                  <div>
                    <strong>{r.label}</strong>
                    <div style={{ fontSize:11, color:MUTE }}>{r.date}{r.note ? ' · ' + r.note : ''}</div>
                  </div>
                  <div style={rightAmt}>-{fmt(r.amount)}</div>
                </div>
              ))}
              {stub.advanceRows.map((r, i) => (
                <div key={'a'+i} style={row}>
                  <div>
                    <strong>{r.label}</strong>
                    <div style={{ fontSize:11, color:MUTE }}>Ref: {r.ref || '-'}</div>
                  </div>
                  <div style={rightAmt}>-{fmt(r.amount)}</div>
                </div>
              ))}

              {/* RECURRING CHARGES — live lines (insurance, plates, payment plans). */}
              {stub.recurringRows.map((r, i) => (
                <div key={'r'+i} style={row}>
                  <div>
                    <strong>{r.label}</strong>
                    <div style={{ fontSize:11, color:MUTE }}>
                      {r.cadence === 'monthly' ? 'Monthly charge, weekly share' : 'Weekly recurring charge'}
                    </div>
                  </div>
                  <div style={rightAmt}>-{fmt(r.amount)}</div>
                </div>
              ))}

              {/* Placeholder shows ONLY when this driver has no recurring charges set up yet. */}
              {!stub.hasRecurring && (
                <div style={{ ...row, color:MUTE, fontStyle:'italic', fontSize:12 }}>
                  <span>Recurring charges (insurance, plates, payment plans) — none set up</span>
                  <span style={{ ...rightAmt, color:MUTE }}>—</span>
                </div>
              )}

              {stub.fleetFuelRows.length === 0 && stub.advanceRows.length === 0 && stub.recurringRows.length === 0 && (
                <div style={{ ...row, color:MUTE, justifyContent:'center' }}>No deductions this week.</div>
              )}
              <div style={totalRow}><span>TOTAL DEDUCTIONS</span><span>-{fmt(stub.totalDeductions)}</span></div>
            </div>

            {/* NET PAY */}
            <div style={{ marginTop:18, borderRadius:6, overflow:'hidden', border:'2px solid #111' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'16px 14px', background:'#fff' }}>
                <div>
                  <div style={{ fontSize:11, color:MUTE, fontFamily:'var(--font-head)', letterSpacing:'0.06em' }}>DRIVER PAY {fmt(stub.driverGross)} − DEDUCTIONS {fmt(stub.totalDeductions)}</div>
                  <div style={{ fontSize:15, fontWeight:900, color:INK, fontFamily:'var(--font-head)', letterSpacing:'0.04em' }}>NET DRIVER PAY</div>
                </div>
                <div style={{ fontSize:24, fontWeight:900, color:INK, fontFamily:'var(--font-head)' }}>{fmt(stub.netPay)}</div>
              </div>
            </div>

            <div style={{ textAlign:'center', fontSize:10, color:MUTE, padding:'24px 0 32px' }}>
              Generated by Load Ledgers — dbappsystems.com<br/>
              Settlement week Monday–Monday · numbers tie to billed loads
            </div>
          </>
        )}
      </div>
      </div>
    </div>
  )

  // Portal to document.body so the fixed overlay escapes App's `.tab-content`
  // scroll container and covers the true viewport (the iOS clipping fix).
  return createPortal(overlay, document.body)
}
