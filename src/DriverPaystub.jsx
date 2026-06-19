// src/DriverPaystub.jsx
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledgers V5 — DRIVER PAYSTUB (weekly settlement, driver-facing).
//
// WHAT THIS IS
//   A read-only driver pay stub for one settlement week, built from data that
//   already exists (loads, fuel_entries, carrier_advances). It reuses the SAME
//   math as settlementMath.js so the numbers tie to billing — this view never
//   writes anything and never changes the running balance. It cannot break
//   billing; it only reads and arranges.
//
// PRESENTATION: a pay document, not a dashboard. ALL fonts are plain black.
//   No red/amber/green. Deductions are shown with a leading minus sign, not
//   color. The net line is black bold. This is intentional — a paystub should
//   read like a printed settlement sheet.
//
// THE STUB (top to bottom), exactly as a driver expects a paystub:
//
//   DRIVER PAY
//     • one line per load: Load #  | Load Total (net_pay billed)  | Driver %  -> $ out right
//     • Fuel Surcharge under the load (load.fuel) when > 0
//     • Detention / extra pay under it (load.detention) when > 0
//     = DRIVER GROSS PAY
//
//   CARRIER DEDUCTIONS
//     • Fleet Fuel Card (fuel_entries, type 'fleet', this week)
//     • Advances — referenced to their note/reason, with remaining balance
//     • [Recurring carrier charges — insurance lines, plate installment,
//        payment arrangements — NOT yet stored anywhere; shown as a clearly
//        labeled, ready section so the layout is complete and we can wire real
//        storage next. Nothing is invented here.]
//     = TOTAL DEDUCTIONS
//
//   NET DRIVER PAY = DRIVER GROSS - TOTAL DEDUCTIONS
//
// SETTLEMENT WEEK
//   Monday -> Monday, cutoff end of day Monday. A load counts in the week that
//   its anchor date falls into, where the week runs Tuesday 00:00 .. the
//   following Monday 23:59 and is PAID on that closing Monday. Anchor date today
//   is the load's billed/delivery date (loadDate from settlementMath) because
//   that is the only billing-completion date the schema currently has; when a
//   dedicated bill date is added, swap weekAnchorDate() to use it — one line.

import { useState, useEffect, useMemo } from 'react'
import { api as apiClient } from './api.js'
import {
  normalizeOwnerCut, parseAppDate, loadDate, calcPay,
} from './settlementMath'

function fmt(n) { return '$' + (parseFloat(n) || 0).toFixed(2) }

// -- SETTLEMENT WEEK MATH (Monday -> Monday, cutoff end of Monday) ------------
// Returns the {start, end, payDate, label} for the settlement week that the
// given offset points to. offset 0 = the current week (the one whose closing
// Monday is the next Monday at/after today). Negative = prior weeks.
//
// A settlement week is paid on its CLOSING MONDAY and contains everything from
// the day after the PREVIOUS Monday through that closing Monday end-of-day:
//   start = (closing Monday - 6 days) 00:00:00   (the Tuesday)
//   end   = closing Monday 23:59:59
function settlementWeek(offset) {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0)
  // JS: 0=Sun,1=Mon,...; find the closing Monday at/after today.
  const dow = d.getDay()
  const daysUntilMon = (1 - dow + 7) % 7   // 0 if today is Monday
  const closingMon = new Date(d)
  closingMon.setDate(d.getDate() + daysUntilMon)
  // apply week offset
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

// A load's anchor date for week bucketing. Today = billed/delivery date.
// Swap this one line to a dedicated bill_date when the schema has one.
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
  const [loading, setLoading] = useState(true)

  // Pull this driver's fuel + advances once (read-only).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [fuel, adv] = await Promise.all([
          apiClient('/api/fuel/' + driverName).catch(() => []),
          apiClient('/api/carrier-advances/' + driverName).catch(() => []),
        ])
        if (cancelled) return
        setFuelEntries(Array.isArray(fuel) ? fuel : [])
        setCarrierAdvances(Array.isArray(adv) ? adv : [])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [driverName])

  const week = useMemo(() => settlementWeek(weekOffset), [weekOffset])
  const cut = normalizeOwnerCut(ownerCutPct)

  // -- DRIVER PAY: loads that fall in this settlement week --------------------
  const stub = useMemo(() => {
    const dLoads = (Array.isArray(loads) ? loads : []).filter(l => l.driver === driverName)
    const weekLoads = dLoads.filter(l => inWeek(weekAnchorDate(l), week))

    const payRows = weekLoads.map(l => {
      const loadTotal = parseFloat(l.net_pay) || parseFloat(l.base_pay) || 0 // billed total
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
        // line subtotal = driver's split + fuel surcharge + detention/extra
        lineTotal: driverBase + fuelSur + detention,
        isAch: !!l.ach_payment,
      }
    })

    const driverGross = payRows.reduce((s, r) => s + r.lineTotal, 0)

    // -- CARRIER DEDUCTIONS --------------------------------------------------
    // Fleet fuel card charged in this week.
    const fleetFuelRows = fuelEntries
      .filter(f => (f.driver || '').toUpperCase() === driverName.toUpperCase()
        && f.fuel_type === 'fleet'
        && inWeek(parseAppDate(f.entry_date), week))
      .map(f => ({ label: 'Fleet Fuel Card', date: f.entry_date, note: f.notes || '', amount: parseFloat(f.amount) || 0 }))
    const fleetFuelTotal = fleetFuelRows.reduce((s, r) => s + r.amount, 0)

    // Carrier advances: unrepaid ones reduce pay. Show each with its reference
    // (reason + note) and the amount. (FIFO per-advance recovery + payment
    // arrangements come in the next step once we store a recovery schedule.)
    const advanceRows = carrierAdvances
      .filter(a => (a.driver || '').toUpperCase() === driverName.toUpperCase() && !a.repaid)
      .map(a => ({
        label: 'Advance' + (a.reason ? ' (' + a.reason + ')' : ''),
        ref: a.notes || a.advance_date || '',
        amount: parseFloat(a.amount) || 0,
      }))
    const advanceTotal = advanceRows.reduce((s, r) => s + r.amount, 0)

    const totalDeductions = fleetFuelTotal + advanceTotal
    const netPay = driverGross - totalDeductions

    return { payRows, driverGross, fleetFuelRows, fleetFuelTotal, advanceRows, advanceTotal, totalDeductions, netPay }
  }, [loads, driverName, week, cut, fuelEntries, carrierAdvances])

  // -- STYLES (paystub look: white sheet, plain BLACK text throughout) -------
  const INK = '#111'            // one ink color for the whole document
  const MUTE = '#555'           // muted black for secondary lines (dates/refs)
  const sheet = { position:'fixed', inset:0, background:'#fff', zIndex:9999, overflowY:'auto', WebkitOverflowScrolling:'touch' }
  const bar   = { position:'sticky', top:0, background:'#fff', borderBottom:'2px solid #111', padding:'12px 16px', display:'flex', alignItems:'center', justifyContent:'space-between', zIndex:10 }
  const wrap  = { padding:16, maxWidth:620, margin:'0 auto', color:INK }
  const sect  = { fontSize:12, fontWeight:900, color:INK, fontFamily:'var(--font-head)', letterSpacing:'0.08em', margin:'18px 0 6px', paddingLeft:2 }
  const card  = { borderRadius:6, border:'1px solid #bbb', overflow:'hidden' }
  const row   = { display:'flex', justifyContent:'space-between', alignItems:'baseline', padding:'10px 12px', borderBottom:'1px solid #e2e2e2', fontSize:13, color:INK }
  const sub   = { ...row, padding:'6px 12px 6px 28px', fontSize:12, color:INK, borderBottom:'1px solid #eee' }
  const rightAmt = { fontFamily:'var(--font-head)', fontWeight:700, color:INK }
  const totalRow = { display:'flex', justifyContent:'space-between', alignItems:'baseline', padding:'12px', background:'#f2f2f2', fontWeight:800, fontSize:14, color:INK, fontFamily:'var(--font-head)' }

  return (
    <div style={sheet}>
      <div style={bar}>
        <div>
          <div style={{ fontSize:11, color:MUTE, fontFamily:'var(--font-head)', letterSpacing:'0.08em' }}>DRIVER SETTLEMENT</div>
          <div style={{ fontSize:16, fontFamily:'var(--font-head)', fontWeight:900, color:INK }}>{driverName}</div>
        </div>
        <button onClick={onClose} style={{ background:'#111', border:'none', color:'#fff', borderRadius:6, padding:'8px 16px', fontSize:14, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }}>X CLOSE</button>
      </div>

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

              {/* Recurring carrier charges — not yet stored; placeholder section
                  so the stub is structurally complete. Real lines wire in next. */}
              <div style={{ ...row, color:MUTE, fontStyle:'italic', fontSize:12 }}>
                <span>Recurring charges (insurance, plates, payment plans) — coming next</span>
                <span style={{ ...rightAmt, color:MUTE }}>—</span>
              </div>

              {stub.fleetFuelRows.length === 0 && stub.advanceRows.length === 0 && (
                <div style={{ ...row, color:MUTE, justifyContent:'center' }}>No deductions this week.</div>
              )}
              <div style={totalRow}><span>TOTAL DEDUCTIONS</span><span>-{fmt(stub.totalDeductions)}</span></div>
            </div>

            {/* NET PAY — plain black, bordered, document style */}
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
  )
}
