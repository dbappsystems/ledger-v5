// src/ScheduleCReport.jsx
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — SCHEDULE C STATEMENT (printable)
//
// A full-screen, print-ready year-end tax statement that matches the
// Settlement Statement / IFTA Statement look and feel token-for-token
// (dark navy header bar, COMPANY/DRIVER info card, TH/TD/TF table styles,
// amber note boxes, dark total bars, footer line).
//
// DATA: reads the GL roll-up the worker builds —
//   GET /api/gl/schedule-c?driver={DRIVER}&from={YYYY-MM-DD}&to={YYYY-MM-DD}
// and binds only real fields the Worker returns:
//   lines[]  { code, label, schedule, line_ref, side, owner_scope, amount, entries }
//   totals   { gross_income, total_deductions, net_schedule_c }
//   driver, period {from,to}, generated_at
// Nothing is fabricated. Every leased owner-operator files their own Schedule C,
// so this statement is per-driver. Amounts already have deductible_pct applied
// server-side (per diem at 80%, etc.), so what prints is the deductible figure.

import { useState } from 'react'
import { api as apiClient } from './api.js'
import { useDrivers } from './useDrivers.js'

// Currency, thousands-separated, two decimals.
function usd(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// -- FULL SCHEDULE C STATEMENT OVERLAY ---------------------------------
function ScheduleCOverlay({ data, driverName, headerColor, year, onClose }) {
  const TH  = { background:'#1a2a3a', color:'#fff', padding:'8px 10px', fontSize:11, fontWeight:700, textAlign:'left', fontFamily:'var(--font-head)', letterSpacing:'0.04em' }
  const TD  = { padding:'8px 10px', fontSize:12, borderBottom:'1px solid #e8e8e8', color:'#222', verticalAlign:'middle' }
  const TDr = { ...TD, textAlign:'right', fontFamily:'var(--font-head)', fontWeight:600 }
  const TF  = { ...TD, background:'#f0f0f0', fontWeight:700, color:'#111' }
  const TFr = { ...TF, textAlign:'right', fontFamily:'var(--font-head)' }

  const lines  = (data && Array.isArray(data.lines)) ? data.lines : []
  const totals = (data && data.totals) || { gross_income:0, total_deductions:0, net_schedule_c:0 }

  // Split by the driver's own Schedule C: income lines vs expense lines.
  // owner_scope 'CARRIER' rows (the carrier's retained commission) are not part
  // of THIS driver's return, so they're excluded from the driver statement.
  const incomeRows  = lines.filter(l => l.side === 'INCOME'  && l.owner_scope === 'DRIVER')
  const expenseRows = lines.filter(l => l.side === 'EXPENSE' && l.owner_scope === 'DRIVER')
                           .sort((a, b) => String(a.line_ref).localeCompare(String(b.line_ref), undefined, { numeric:true }))
  // Balance-sheet items (advances, escrow, broker advance) are shown separately
  // as a note — they are NOT Schedule C income or expense.
  const bsRows = lines.filter(l => l.schedule === 'BALANCE_SHEET')

  const generated = new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })
  const periodLabel = (data && data.period && data.period.from && data.period.to)
    ? (data.period.from + '  to  ' + data.period.to)
    : ('Tax Year ' + year)

  return (
    <div style={{ position:'fixed', top:0, left:0, right:0, bottom:0, background:'#fff', zIndex:9999, overflowY:'auto', WebkitOverflowScrolling:'touch' }}>
      <div style={{ position:'sticky', top:0, background:'#1a2a3a', padding:'12px 16px', display:'flex', alignItems:'center', justifyContent:'space-between', zIndex:10 }}>
        <div>
          <div style={{ fontSize:11, color:'rgba(255,255,255,0.6)', fontFamily:'var(--font-head)', letterSpacing:'0.08em' }}>SCHEDULE C STATEMENT</div>
          <div style={{ fontSize:16, fontFamily:'var(--font-head)', fontWeight:900, color: headerColor || '#64b5f6' }}>{driverName}</div>
          <div style={{ fontSize:10, color:'rgba(255,255,255,0.5)', fontFamily:'var(--font-head)', letterSpacing:'0.06em', marginTop:2 }}>TAX YEAR: {year}</div>
        </div>
        <button onClick={onClose} style={{ background:'rgba(255,255,255,0.15)', border:'none', color:'#fff', borderRadius:8, padding:'8px 16px', fontSize:14, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }}>X CLOSE</button>
      </div>
      <div style={{ padding:'16px', maxWidth:600, margin:'0 auto' }}>

        {/* INFO CARD */}
        <div style={{ background:'#f8f8f8', borderRadius:8, padding:'12px 14px', marginBottom:16, border:'1px solid #e0e0e0' }}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, fontSize:12, color:'#444' }}>
            <div><span style={{ color:'#888', fontSize:11 }}>CARRIER</span><br /><strong>Edgerton Truck &amp; Trailer Repair</strong></div>
            <div><span style={{ color:'#888', fontSize:11 }}>OWNER-OPERATOR</span><br /><strong>{driverName}</strong></div>
            <div><span style={{ color:'#888', fontSize:11 }}>PERIOD</span><br /><strong>{periodLabel}</strong></div>
            <div><span style={{ color:'#888', fontSize:11 }}>GENERATED</span><br /><strong>{generated}</strong></div>
          </div>
        </div>

        {/* GROSS RECEIPTS (INCOME) */}
        <div style={{ marginBottom:16 }}>
          <div style={{ fontSize:12, fontWeight:900, color:'#1a2a3a', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:6, paddingLeft:4 }}>PART I — GROSS RECEIPTS</div>
          <div style={{ borderRadius:8, border:'1px solid #e0e0e0', overflow:'hidden' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
              <thead><tr>
                <th style={{...TH, width:52}}>Line</th>
                <th style={TH}>Description</th>
                <th style={{...TH,textAlign:'right'}}>Amount</th>
              </tr></thead>
              <tbody>
                {incomeRows.length === 0 && (
                  <tr><td style={TD} colSpan={3}>No income recorded for this period.</td></tr>
                )}
                {incomeRows.map((r, i) => (
                  <tr key={r.code} style={{ background:i%2===0?'#fff':'#fafafa' }}>
                    <td style={{...TD,color:'#888',fontFamily:'var(--font-head)'}}>{r.line_ref}</td>
                    <td style={TD}>{r.label}</td>
                    <td style={{...TDr,color:'#2e7d32'}}>{usd(r.amount)}</td>
                  </tr>
                ))}
                <tr>
                  <td style={TF} colSpan={2}>GROSS INCOME</td>
                  <td style={{...TFr,color:'#2e7d32'}}>{usd(totals.gross_income)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* DEDUCTIONS (EXPENSES) */}
        <div style={{ marginBottom:16 }}>
          <div style={{ fontSize:12, fontWeight:900, color:'#1a2a3a', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:6, paddingLeft:4 }}>PART II — EXPENSES</div>
          <div style={{ background:'#fff8e1', border:'1px solid #ffe082', borderRadius:8, padding:'10px 14px', marginBottom:8, fontSize:11, color:'#7a5c00' }}>
            Each line maps to its IRS Schedule C line. Fuel combines fleet-card and out-of-pocket purchases — both are this owner-operator&apos;s expense. Meals per diem is shown at the deductible 80%. The carrier split is a deductible commission on line 10. Verify these figures against your records before filing.
          </div>
          <div style={{ borderRadius:8, border:'1px solid #e0e0e0', overflow:'hidden' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
              <thead><tr>
                <th style={{...TH, width:52}}>Line</th>
                <th style={TH}>Description</th>
                <th style={{...TH,textAlign:'right'}}>Entries</th>
                <th style={{...TH,textAlign:'right'}}>Amount</th>
              </tr></thead>
              <tbody>
                {expenseRows.length === 0 && (
                  <tr><td style={TD} colSpan={4}>No expenses recorded for this period.</td></tr>
                )}
                {expenseRows.map((r, i) => (
                  <tr key={r.code} style={{ background:i%2===0?'#fff':'#fafafa' }}>
                    <td style={{...TD,color:'#888',fontFamily:'var(--font-head)'}}>{r.line_ref}</td>
                    <td style={TD}>{r.label}</td>
                    <td style={{...TDr,color:'#888',fontWeight:600}}>{r.entries}</td>
                    <td style={{...TDr,color:'#c62828'}}>{usd(r.amount)}</td>
                  </tr>
                ))}
                <tr>
                  <td style={TF} colSpan={3}>TOTAL DEDUCTIONS</td>
                  <td style={{...TFr,color:'#c62828'}}>{usd(totals.total_deductions)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* NET PROFIT BAR */}
        <div style={{ marginBottom:16 }}>
          <div style={{ borderRadius:8, border:'1px solid #e0e0e0', overflow:'hidden' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <tbody>
                <tr><td style={TD}>Gross income</td><td style={{...TDr,color:'#2e7d32'}}>{usd(totals.gross_income)}</td></tr>
                <tr style={{background:'#fafafa'}}><td style={TD}>Less total deductions</td><td style={{...TDr,color:'#c62828'}}>({usd(totals.total_deductions)})</td></tr>
                <tr style={{background:'#1a2a3a'}}>
                  <td style={{ padding:'14px 12px', fontSize:15, fontWeight:900, color:'#fff', fontFamily:'var(--font-head)', letterSpacing:'0.04em' }}>NET PROFIT (SCHEDULE C, LINE 31)</td>
                  <td style={{ padding:'14px 12px', textAlign:'right', fontSize:20, fontWeight:900, color: (Number(totals.net_schedule_c)>=0?'#ffd54f':'#ff8a80'), fontFamily:'var(--font-head)' }}>{usd(totals.net_schedule_c)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* BALANCE-SHEET NOTE (advances / escrow / broker advance) */}
        {bsRows.length > 0 && (
          <div style={{ marginBottom:24 }}>
            <div style={{ fontSize:12, fontWeight:900, color:'#1a2a3a', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:6, paddingLeft:4 }}>NOT ON SCHEDULE C — BALANCE-SHEET ITEMS</div>
            <div style={{ background:'#fff8e1', border:'1px solid #ffe082', borderRadius:8, padding:'10px 14px', marginBottom:8, fontSize:11, color:'#7a5c00' }}>
              These are loans and held funds, not income or expense. Carrier advances are a loan repaid from settlement; escrow is money held for you and refundable; broker advances net against costs on the broker invoice. They are listed here for reconciliation only and do not affect net profit.
            </div>
            <div style={{ borderRadius:8, border:'1px solid #e0e0e0', overflow:'hidden' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead><tr>
                  <th style={TH}>Item</th>
                  <th style={{...TH,textAlign:'right'}}>Entries</th>
                  <th style={{...TH,textAlign:'right'}}>Amount</th>
                </tr></thead>
                <tbody>
                  {bsRows.map((r, i) => (
                    <tr key={r.code} style={{ background:i%2===0?'#fff':'#fafafa' }}>
                      <td style={TD}>{r.label}</td>
                      <td style={{...TDr,color:'#888',fontWeight:600}}>{r.entries}</td>
                      <td style={{...TDr,color:'#555'}}>{usd(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div style={{ textAlign:'center', fontSize:10, color:'#aaa', paddingBottom:32 }}>
          Not tax advice. Verify all figures before filing. Generated by Load Ledger — dbappsystems.com
        </div>
      </div>
    </div>
  )
}

// -- BUTTON + LOADER ---------------------------------------------------
// Drop-in: <ScheduleCReport driver={driver} year={2026} />
// year is optional; defaults to the current year. Pulls the full Jan 1 - Dec 31
// window for that year.
export default function ScheduleCReport({ driver, year: yearProp }) {
  const { colorFor } = useDrivers()
  const headerColor = colorFor(driver)
  const year = yearProp != null ? yearProp : new Date().getFullYear()

  const [open,    setOpen]    = useState(false)
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  async function openReport() {
    if (!driver) return
    setLoading(true)
    setError('')
    try {
      const from = year + '-01-01'
      const to   = year + '-12-31'
      const qs = '?driver=' + encodeURIComponent(driver) + '&from=' + from + '&to=' + to
      const json = await apiClient('/api/gl/schedule-c' + qs)
      setData(json && Array.isArray(json.lines) ? json : { lines: [], totals: { gross_income:0, total_deductions:0, net_schedule_c:0 } })
      setOpen(true)
    } catch (err) {
      setError((err.message || 'Failed to load Schedule C statement').slice(0, 80))
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <button
        className="scan-btn"
        style={{ width:'100%', padding:'12px', fontSize:13 }}
        disabled={loading || !driver}
        onClick={openReport}
      >
        {loading ? '...' : 'SCHEDULE C STATEMENT'}
      </button>
      {error && <div style={{ fontSize:11, color:'#e53935', marginTop:8 }}>⚠️ {error}</div>}
      {open && data && (
        <ScheduleCOverlay
          data={data}
          driverName={(driver || '').toUpperCase()}
          headerColor={headerColor}
          year={year}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
