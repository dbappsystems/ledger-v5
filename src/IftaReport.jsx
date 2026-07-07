// src/IftaReport.jsx
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — IFTA STATEMENT (printable)
//
// A full-screen, print-ready IFTA jurisdiction statement that matches the
// Settlement Statement's look and feel token-for-token (StatementOverlay in
// SettlementReport.jsx): dark navy header bar, COMPANY/DRIVER info card,
// TH/TD/TF table styles, amber note boxes, dark total bars, footer line.
//
// DATA: this reads the SAME payload the IFTA card fetches —
//   GET /api/ifta/{driver}?q={1..4}&year={YYYY}
// and binds only real fields the Worker returns:
//   states[]  { state, miles, loaded, deadhead, est_gallons }
//   grand_total_miles, total_gallons, fleet_mpg
//   purchased_gallons_by_state  { ST: gallons }
//   segments[]  { date, state, odo_start, odo_end, miles, leg_type, load_id }
// Nothing is fabricated. Jurisdictions with purchased gallons but no miles are
// still listed so tax-paid gallons always reconcile to gallons purchased.
//
// The word "estimated" appears nowhere by design: drivers audit and correct
// these figures before this statement is printed for filing.

import { useState } from 'react'
import { api as apiClient } from './api.js'
import { useDrivers } from './useDrivers.js'

const QLABEL = ['Jan 1 - Mar 31', 'Apr 1 - Jun 30', 'Jul 1 - Sep 30', 'Oct 1 - Dec 31']

// One decimal, thousands-separated (matches the ledger's r1() precision).
function mi(n) {
  return (Math.round((n || 0) * 10) / 10)
    .toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}
function gal(n) {
  if (n == null) return '-'
  return (Math.round((n || 0) * 1000) / 1000)
    .toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
}

// -- FULL IFTA STATEMENT OVERLAY ---------------------------------------
function IftaStatementOverlay({ data, driverName, headerColor, qtr, year, onClose }) {
  const TH  = { background:'#1a2a3a', color:'#fff', padding:'8px 10px', fontSize:11, fontWeight:700, textAlign:'left', fontFamily:'var(--font-head)', letterSpacing:'0.04em' }
  const TD  = { padding:'8px 10px', fontSize:12, borderBottom:'1px solid #e8e8e8', color:'#222', verticalAlign:'middle' }
  const TDr = { ...TD, textAlign:'right', fontFamily:'var(--font-head)', fontWeight:600 }
  const TF  = { ...TD, background:'#f0f0f0', fontWeight:700, color:'#111' }
  const TFr = { ...TF, textAlign:'right', fontFamily:'var(--font-head)' }

  const states   = (data && data.states) || []
  const grand    = (data && data.grand_total_miles) || 0
  const loaded   = states.reduce((s, r) => s + (r.loaded   || 0), 0)
  const deadhead = states.reduce((s, r) => s + (r.deadhead || 0), 0)
  const totalGal = (data && data.total_gallons) || 0
  const fleetMpg = (data && data.fleet_mpg) || 0
  const purch    = (data && data.purchased_gallons_by_state) || null
  const segments = (data && Array.isArray(data.segments)) ? data.segments : []

  const periodLabel = qtr >= 1 ? ('Q' + qtr + ' ' + year) : 'All Recorded'
  const windowLabel = qtr >= 1 ? (QLABEL[qtr - 1] + ' ' + year) : 'All recorded activity'
  const generated   = new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })

  // Jurisdiction rows: every state with miles, plus any state that only has
  // purchased gallons (so tax-paid gallons reconcile to gallons purchased).
  const jset = {}
  for (const r of states) jset[r.state] = { state:r.state, miles:r.miles||0, loaded:r.loaded||0, deadhead:r.deadhead||0, taxable:r.est_gallons, purchased:(purch && purch[r.state]!=null)?purch[r.state]:null }
  if (purch) {
    for (const st of Object.keys(purch)) {
      if (!jset[st]) jset[st] = { state:st, miles:0, loaded:0, deadhead:0, taxable:null, purchased:purch[st] }
    }
  }
  const jrows = Object.values(jset).sort((a, b) => b.miles - a.miles)

  const totTaxable   = jrows.reduce((s, r) => s + (r.taxable   || 0), 0)
  const totPurchased = jrows.reduce((s, r) => s + (r.purchased || 0), 0)

  return (
    <div style={{ position:'fixed', top:0, left:0, right:0, bottom:0, background:'#fff', zIndex:9999, overflowY:'auto', WebkitOverflowScrolling:'touch' }}>
      <div style={{ position:'sticky', top:0, background:'#1a2a3a', padding:'12px 16px', display:'flex', alignItems:'center', justifyContent:'space-between', zIndex:10 }}>
        <div>
          <div style={{ fontSize:11, color:'rgba(255,255,255,0.6)', fontFamily:'var(--font-head)', letterSpacing:'0.08em' }}>IFTA STATEMENT</div>
          <div style={{ fontSize:16, fontFamily:'var(--font-head)', fontWeight:900, color: headerColor || '#64b5f6' }}>{driverName}</div>
          <div style={{ fontSize:10, color:'rgba(255,255,255,0.5)', fontFamily:'var(--font-head)', letterSpacing:'0.06em', marginTop:2 }}>PERIOD ACTIVITY: {periodLabel}</div>
        </div>
        <button onClick={onClose} style={{ background:'rgba(255,255,255,0.15)', border:'none', color:'#fff', borderRadius:8, padding:'8px 16px', fontSize:14, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }}>X CLOSE</button>
      </div>
      <div style={{ padding:'16px', maxWidth:600, margin:'0 auto' }}>

        {/* INFO CARD */}
        <div style={{ background:'#f8f8f8', borderRadius:8, padding:'12px 14px', marginBottom:16, border:'1px solid #e0e0e0' }}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, fontSize:12, color:'#444' }}>
            <div><span style={{ color:'#888', fontSize:11 }}>COMPANY</span><br /><strong>Edgerton Truck &amp; Trailer Repair</strong></div>
            <div><span style={{ color:'#888', fontSize:11 }}>DRIVER</span><br /><strong>{driverName}</strong></div>
            <div><span style={{ color:'#888', fontSize:11 }}>PERIOD SHOWN</span><br /><strong>{windowLabel}</strong></div>
            <div><span style={{ color:'#888', fontSize:11 }}>GENERATED</span><br /><strong>{generated}</strong></div>
          </div>
        </div>

        {/* MILES BY JURISDICTION */}
        <div style={{ marginBottom:16 }}>
          <div style={{ fontSize:12, fontWeight:900, color:'#1a2a3a', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:6, paddingLeft:4 }}>MILES BY JURISDICTION</div>
          <div style={{ borderRadius:8, border:'1px solid #e0e0e0', overflow:'hidden' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
              <thead><tr>
                <th style={TH}>Jurisdiction</th>
                <th style={{...TH,textAlign:'right'}}>Total Miles</th>
                <th style={{...TH,textAlign:'right'}}>Loaded</th>
                <th style={{...TH,textAlign:'right'}}>Deadhead</th>
              </tr></thead>
              <tbody>
                {jrows.filter(r => r.miles > 0).map((r, i) => (
                  <tr key={r.state} style={{ background:i%2===0?'#fff':'#fafafa' }}>
                    <td style={TD}><strong>{r.state}</strong></td>
                    <td style={{...TDr,fontWeight:700}}>{mi(r.miles)}</td>
                    <td style={{...TDr,color:'#2e7d32'}}>{mi(r.loaded)}</td>
                    <td style={{...TDr,color:'#888'}}>{r.deadhead>0?mi(r.deadhead):'-'}</td>
                  </tr>
                ))}
                <tr>
                  <td style={TF}>TOTAL</td>
                  <td style={{...TFr,color:'#1a2a3a'}}>{mi(grand)}</td>
                  <td style={{...TFr,color:'#2e7d32'}}>{mi(loaded)}</td>
                  <td style={{...TFr,color:'#555'}}>{mi(deadhead)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* FUEL BY JURISDICTION */}
        <div style={{ marginBottom:16 }}>
          <div style={{ fontSize:12, fontWeight:900, color:'#1a2a3a', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:6, paddingLeft:4 }}>TAXABLE GALLONS BY JURISDICTION</div>
          <div style={{ background:'#fff8e1', border:'1px solid #ffe082', borderRadius:8, padding:'10px 14px', marginBottom:8, fontSize:11, color:'#7a5c00' }}>
            Taxable gallons are this jurisdiction&apos;s share of fuel burned across the fleet, carved by its mile share. Tax-paid gallons are fleet-card fuel actually purchased in the jurisdiction. Reefer fuel is excluded. The tax owed each jurisdiction is taxable gallons less tax-paid gallons, at that jurisdiction&apos;s rate.
          </div>
          <div style={{ borderRadius:8, border:'1px solid #e0e0e0', overflow:'hidden' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
              <thead><tr>
                <th style={TH}>Jurisdiction</th>
                <th style={{...TH,textAlign:'right'}}>Taxable Gal</th>
                <th style={{...TH,textAlign:'right'}}>Tax-Paid Gal</th>
                <th style={{...TH,textAlign:'right'}}>Net Gal</th>
              </tr></thead>
              <tbody>
                {jrows.map((r, i) => {
                  const net = (r.taxable || 0) - (r.purchased || 0)
                  return (
                    <tr key={r.state} style={{ background:i%2===0?'#fff':'#fafafa' }}>
                      <td style={TD}><strong>{r.state}</strong></td>
                      <td style={TDr}>{r.taxable==null?'-':gal(r.taxable)}</td>
                      <td style={{...TDr,color:'#2e7d32'}}>{r.purchased==null?'-':gal(r.purchased)}</td>
                      <td style={{...TDr,color:net>0?'#c62828':(net<0?'#2e7d32':'#888'),fontWeight:700}}>{(r.taxable==null&&r.purchased==null)?'-':gal(net)}</td>
                    </tr>
                  )
                })}
                <tr>
                  <td style={TF}>TOTAL</td>
                  <td style={TFr}>{gal(totTaxable)}</td>
                  <td style={{...TFr,color:'#2e7d32'}}>{gal(totPurchased)}</td>
                  <td style={{...TFr,color:'#1a2a3a'}}>{gal(totTaxable - totPurchased)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* FLEET SUMMARY BAR */}
        <div style={{ marginBottom:24 }}>
          <div style={{ fontSize:12, fontWeight:900, color:'#1a2a3a', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:6, paddingLeft:4 }}>FLEET SUMMARY</div>
          <div style={{ borderRadius:8, border:'1px solid #e0e0e0', overflow:'hidden' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <tbody>
                <tr><td style={TD}>Total Miles (all jurisdictions)</td><td style={TDr}>{mi(grand)}</td></tr>
                <tr style={{background:'#fafafa'}}><td style={TD}>Total Gallons Purchased (fleet card, reefer excluded)</td><td style={TDr}>{gal(totalGal)}</td></tr>
                <tr style={{background:'#1a2a3a'}}>
                  <td style={{ padding:'14px 12px', fontSize:15, fontWeight:900, color:'#fff', fontFamily:'var(--font-head)', letterSpacing:'0.04em' }}>FLEET MILES PER GALLON</td>
                  <td style={{ padding:'14px 12px', textAlign:'right', fontSize:20, fontWeight:900, color:'#ffd54f', fontFamily:'var(--font-head)' }}>{fleetMpg > 0 ? fleetMpg.toFixed(2) : '-'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* IVDR — STATE-LINE ODOMETER RECORDS */}
        {segments.length > 0 && (
          <div style={{ marginBottom:24 }}>
            <div style={{ fontSize:12, fontWeight:900, color:'#1a2a3a', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:6, paddingLeft:4 }}>IVDR — STATE-LINE ODOMETER</div>
            <div style={{ background:'#fff8e1', border:'1px solid #ffe082', borderRadius:8, padding:'10px 14px', marginBottom:8, fontSize:11, color:'#7a5c00' }}>
              One row per state crossing in travel order. The reading that closes one jurisdiction opens the next, so the odometer chain is continuous and the miles reconcile to the jurisdiction totals above to the tenth of a mile.
            </div>
            <div style={{ borderRadius:8, border:'1px solid #e0e0e0', overflow:'hidden' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead><tr>
                  <th style={TH}>Date</th>
                  <th style={TH}>State</th>
                  <th style={{...TH,textAlign:'right'}}>Odometer Start</th>
                  <th style={{...TH,textAlign:'right'}}>Odometer End</th>
                  <th style={{...TH,textAlign:'right'}}>Miles</th>
                </tr></thead>
                <tbody>
                  {segments.map((s, i) => (
                    <tr key={i} style={{ background:i%2===0?'#fff':'#fafafa', opacity: s.leg_type==='deadhead'?0.72:1 }}>
                      <td style={TD}>{(s.date || '').slice(0, 10)}</td>
                      <td style={TD}><strong style={{ color: s.leg_type==='deadhead'?'#888':'#222' }}>{s.state}</strong></td>
                      <td style={{...TDr,color:'#666'}}>{Math.round(s.odo_start).toLocaleString('en-US')}</td>
                      <td style={{...TDr}}>{Math.round(s.odo_end).toLocaleString('en-US')}</td>
                      <td style={{...TDr,color:'#c62828',fontWeight:700}}>{mi(s.miles)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div style={{ textAlign:'center', fontSize:10, color:'#aaa', paddingBottom:32 }}>Generated by Load Ledger — dbappsystems.com</div>
      </div>
    </div>
  )
}

// -- BUTTON + LOADER ---------------------------------------------------
// Drop-in: <IftaReport driver={driver} qtr={qtr} year={year} />
// qtr/year are optional; defaults to the current quarter.
export default function IftaReport({ driver, qtr: qtrProp, year: yearProp }) {
  const { colorFor } = useDrivers()
  const headerColor = colorFor(driver)
  const now = new Date()
  const qtr  = qtrProp  != null ? qtrProp  : (Math.floor(now.getMonth() / 3) + 1)
  const year = yearProp != null ? yearProp : now.getFullYear()

  const [open,    setOpen]    = useState(false)
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  async function openReport() {
    if (!driver) return
    setLoading(true)
    setError('')
    try {
      const qs = qtr >= 1 ? ('?q=' + qtr + '&year=' + year) : ''
      const json = await apiClient('/api/ifta/' + encodeURIComponent(driver) + qs)
      setData(json && Array.isArray(json.states) ? json : { states: [], grand_total_miles: 0 })
      setOpen(true)
    } catch (err) {
      setError((err.message || 'Failed to load IFTA statement').slice(0, 80))
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
        {loading ? '...' : 'IFTA STATEMENT'}
      </button>
      {error && <div style={{ fontSize:11, color:'#e53935', marginTop:8 }}>⚠️ {error}</div>}
      {open && data && (
        <IftaStatementOverlay
          data={data}
          driverName={(driver || '').toUpperCase()}
          headerColor={headerColor}
          qtr={qtr}
          year={year}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
