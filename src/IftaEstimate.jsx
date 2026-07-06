// src/IftaEstimate.jsx
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — Estimated IFTA Miles + Gallons by State
//
// Data source: GET /api/ifta/{driver} — the ongoing ifta_miles ledger the
// Worker writes when a load is invoiced. Invoice.jsx STEP 1b saves the rate
// con's stops[] to load_stops, then fires POST /api/loads/{id}/route-ifta,
// which routes the stops over real highways and splits the miles by state.
//
// Miles are routed truck-profile highway miles — ORS driving-hgv when the
// ORS_API_KEY Worker secret is set (rows source='routed'), OSRM fallback
// otherwise (rows source='estimated'). Every figure on this card is an
// ESTIMATE for IFTA filing preparation.
//
// GALLONS (fuel side): the Worker sums fleet-card gallons purchased in the
// same quarter (fuel_entries.gallons), derives an estimated Fleet MPG
// (miles / gallons), and carves gallons across states by each state's mile
// share so per-state gallons SUM to gallons purchased. Out-of-pocket fuel
// records dollars but no gallons, so it is not in this figure. Reconcile
// against Tim's in-cab odometer ledger (odometer at fueling + at each state
// line) before filing.
//
// IFTA is filed QUARTERLY (Q1 due Apr 30, Q2 due Jul 31, Q3 due Oct 31,
// Q4 due Jan 31). This card defaults to the current quarter and offers
// Q1-Q4 pills + a year stepper, plus ALL for the running ledger view.
// The Worker filters year-safely via ?q=&year= (substr match on the stored
// MM/DD/YYYY entry_date) — no cross-year lexicographic leakage.

import { useState, useEffect } from 'react'
import { api as apiClient } from './api.js'
import { useDrivers } from './useDrivers.js'

export default function IftaEstimate({ driver }) {
  const { colorFor } = useDrivers()
  const driverColor = colorFor(driver)

  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [open,    setOpen]    = useState(false)
  const [ivdrOpen, setIvdrOpen] = useState(false)
  const now = new Date()
  const [qtr,  setQtr]  = useState(Math.floor(now.getMonth() / 3) + 1) // 1..4, 0 = ALL
  const [year, setYear] = useState(now.getFullYear())

  async function fetchIfta() {
    if (!driver) return
    setLoading(true)
    setError('')
    try {
      const qs = qtr >= 1 ? ('?q=' + qtr + '&year=' + year) : ''
      const json = await apiClient('/api/ifta/' + encodeURIComponent(driver) + qs)
      setData(json && Array.isArray(json.states)
        ? json
        : { states: [], grand_total_miles: 0 })
    } catch (err) {
      setError((err.message || 'Failed to load IFTA miles').slice(0, 80))
    } finally {
      setLoading(false)
    }
  }

  // Refetch whenever the driver changes; collapse so the new driver's table
  // never renders under the old driver's expanded state.
  useEffect(() => {
    setData(null)
    setOpen(false)
    setIvdrOpen(false)
    fetchIfta()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driver, qtr, year])

  const states   = (data && data.states) || []
  const grand    = (data && data.grand_total_miles) || 0
  const loaded   = states.reduce((s, r) => s + (r.loaded   || 0), 0)
  const deadhead = states.reduce((s, r) => s + (r.deadhead || 0), 0)
  const anyOsrm  = states.some(r => r.source === 'estimated')
  const hasXX    = states.some(r => r.state === 'XX')

  // Fuel side (all ESTIMATED; fleet-card gallons only).
  const totalGal = (data && data.total_gallons) || 0
  const fleetMpg = (data && data.fleet_mpg) || 0
  const hasGal   = totalGal > 0 && fleetMpg > 0

  // IVDR state-line odometer segments (from ifta_segments) + purchased
  // gallons by state (parsed from fuel-report merchant notes). Both arrive
  // on the same summary payload — no extra request.
  const segments = (data && Array.isArray(data.segments)) ? data.segments : []
  const purch    = (data && data.purchased_gallons_by_state) || null

  // One decimal, thousands-separated — matches the ledger's r1() precision.
  function mi(n) {
    return (Math.round((n || 0) * 10) / 10)
      .toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  }
  // Gallons — one decimal, thousands-separated.
  function gal(n) {
    return (Math.round((n || 0) * 10) / 10)
      .toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  }

  // IVDR CSV — quarterly Individual Vehicle Distance Record for the filing
  // agent. Spreadsheet format is the audit requirement (XLS/XLSX/CSV; static
  // PDFs are not acceptable for computed distance records). Built entirely
  // client-side from the summary payload; one file per driver per window.
  function downloadIvdrCsv() {
    const esc = (v) => {
      const s = String(v == null ? '' : v)
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
    }
    const windowLabel = qtr >= 1 ? 'Q' + qtr + ' ' + year : 'ALL RECORDED'
    const lines = []
    lines.push(['INDIVIDUAL VEHICLE DISTANCE RECORD (IVDR) - ESTIMATED'].join(','))
    lines.push(['Driver', driver].map(esc).join(','))
    lines.push(['Period', windowLabel].map(esc).join(','))
    lines.push(['Method', 'Routed truck-profile highway miles; odometer chain derived from routed miles (anchor estimated); state-line dates interpolated between pickup and delivery. All figures are estimates for filing preparation.'].map(esc).join(','))
    lines.push('')
    lines.push(['Date','Load','Leg','State','Odometer Start','Odometer End','Miles','Notes'].join(','))
    for (const s of segments) {
      lines.push([
        s.date, (s.load_id || '').slice(0, 8), s.leg_type, s.state,
        (s.odo_start || 0).toFixed(1), (s.odo_end || 0).toFixed(1),
        (s.miles || 0).toFixed(1), s.notes || '',
      ].map(esc).join(','))
    }
    lines.push('')
    lines.push(['SUMMARY - MILES + GALLONS BY STATE'].join(','))
    lines.push(['State','Total Miles','Loaded','Deadhead','Est Gallons Consumed','Gallons Purchased'].join(','))
    for (const r of states) {
      lines.push([
        r.state, (r.miles || 0).toFixed(1), (r.loaded || 0).toFixed(1),
        (r.deadhead || 0).toFixed(1),
        r.est_gallons == null ? '' : r.est_gallons.toFixed(3),
        purch && purch[r.state] != null ? purch[r.state].toFixed(3) : '',
      ].map(esc).join(','))
    }
    if (purch) {
      for (const st of Object.keys(purch)) {
        if (!states.some(r => r.state === st)) {
          lines.push([st, '0.0', '0.0', '0.0', '', purch[st].toFixed(3)].map(esc).join(','))
        }
      }
    }
    lines.push('')
    lines.push(['TOTAL MILES', (grand || 0).toFixed(1)].join(','))
    lines.push(['GALLONS PURCHASED (truck fuel, reefer excluded)', (totalGal || 0).toFixed(3)].join(','))
    if (fleetMpg > 0) lines.push(['FLEET MPG (estimated)', fleetMpg.toFixed(2)].join(','))
    const fname = 'IVDR_' + driver + '_' + (qtr >= 1 ? 'Q' + qtr + '_' + year : 'ALL') + '.csv'
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const aEl = document.createElement('a')
    aEl.href = url
    aEl.download = fname
    document.body.appendChild(aEl)
    aEl.click()
    document.body.removeChild(aEl)
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }

  // Per-state grid widens by one column when gallons are present.
  const gridCols = hasGal ? '44px 1fr 1fr 0.85fr 1fr' : '56px 1fr 1fr 1fr'

  return (
    <div className="card" style={{ borderLeft: '3px solid ' + driverColor }}>

      {/* Header — tap to expand the per-state table */}
      <div
        style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', cursor:'pointer' }}
        onClick={() => setOpen(o => !o)}
      >
        <div>
          <div style={{ fontFamily:'var(--font-head)', fontWeight:900, fontSize:15, color:driverColor, letterSpacing:'0.05em' }}>
            IFTA MILES + GALLONS
            <span style={{ marginLeft:8, fontSize:9, fontWeight:900, color:'#0A1628', background:'var(--amber)', borderRadius:4, padding:'2px 6px', letterSpacing:'0.08em', verticalAlign:'middle' }}>
              ESTIMATED
            </span>
          </div>
          <div style={{ fontSize:11, color:'var(--grey)', marginTop:3 }}>
            {qtr >= 1
              ? 'Q' + qtr + ' ' + year + ' \u00b7 ' + ['Jan 1 - Mar 31','Apr 1 - Jun 30','Jul 1 - Sep 30','Oct 1 - Dec 31'][qtr - 1] + ' \u00b7 loaded + deadhead'
              : 'Routed truck highway miles - loaded + deadhead - all time'}
          </div>
        </div>
        <div style={{ textAlign:'right' }}>
          <div style={{ fontFamily:'var(--font-head)', fontSize:22, fontWeight:900, color:'var(--amber)' }}>
            {loading ? '...' : mi(grand)}
          </div>
          <div style={{ fontSize:10, color:'var(--grey)', marginTop:2 }}>total miles</div>
          {hasGal && !loading && (
            <div style={{ fontSize:10, color:'var(--grey)', marginTop:3 }}>
              {gal(totalGal)} gal {'\u00b7'} {fleetMpg.toFixed(2)} mpg
            </div>
          )}
          <div style={{ fontSize:12, color:'var(--grey)', marginTop:4 }}>{open ? '▲' : '▼'}</div>
        </div>
      </div>

      {/* Quarter selector — IFTA filings are quarterly */}
      <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:12 }} onClick={e => e.stopPropagation()}>
        {[1,2,3,4].map(n => (
          <button key={n} onClick={() => setQtr(n)}
            style={{ flex:1, padding:'7px 0', borderRadius:8, border:'none', cursor:'pointer', fontFamily:'var(--font-head)', fontWeight:900, fontSize:11, letterSpacing:'0.05em',
              background: qtr === n ? 'var(--amber)' : 'var(--navy3)',
              color: qtr === n ? '#0A1628' : 'var(--grey)' }}>
            {'Q' + n}
          </button>
        ))}
        <button onClick={() => setQtr(0)}
          style={{ flex:1, padding:'7px 0', borderRadius:8, border:'none', cursor:'pointer', fontFamily:'var(--font-head)', fontWeight:900, fontSize:11, letterSpacing:'0.05em',
            background: qtr === 0 ? 'var(--amber)' : 'var(--navy3)',
            color: qtr === 0 ? '#0A1628' : 'var(--grey)' }}>
          ALL
        </button>
        <div style={{ display:'flex', alignItems:'center', gap:4, marginLeft:2, opacity: qtr >= 1 ? 1 : 0.35 }}>
          <button onClick={() => qtr >= 1 && setYear(y => y - 1)} style={{ background:'transparent', border:'none', color:'var(--grey)', cursor:'pointer', fontSize:14, padding:'0 2px' }}>{'\u2039'}</button>
          <span style={{ fontFamily:'var(--font-head)', fontWeight:700, fontSize:12, color:'var(--white)' }}>{year}</span>
          <button onClick={() => qtr >= 1 && setYear(y => y + 1)} style={{ background:'transparent', border:'none', color:'var(--grey)', cursor:'pointer', fontSize:14, padding:'0 2px' }}>{'\u203a'}</button>
        </div>
      </div>

      {error && (
        <div style={{ fontSize:11, color:'#e53935', marginTop:10 }}>⚠️ {error}</div>
      )}

      {!loading && !error && states.length === 0 && (
        <div style={{ fontSize:11, color:'var(--grey)', marginTop:10 }}>
          {qtr >= 1 ? 'No miles recorded in Q' + qtr + ' ' + year + '.' : 'No routed miles yet.'} State
          miles build automatically each time a load is invoiced with its stops
          scanned from the rate con.
        </div>
      )}

      {open && states.length > 0 && (
        <div style={{ marginTop:14 }} onClick={e => e.stopPropagation()}>

          {/* Loaded / deadhead split + fuel summary */}
          <div style={{ background:'var(--navy3)', borderRadius:8, padding:'10px 12px', marginBottom:12 }}>
            <div className="amount-row">
              <span className="label">Loaded Miles</span>
              <span className="value" style={{ color:'var(--green)' }}>{mi(loaded)}</span>
            </div>
            <div className="amount-row" style={{ marginBottom: hasGal ? undefined : 0 }}>
              <span className="label">Deadhead Miles</span>
              <span className="value" style={{ color:'var(--grey)' }}>{mi(deadhead)}</span>
            </div>
            {hasGal && (
              <>
                <div style={{ height:1, background:'var(--border)', margin:'8px 0' }} />
                <div className="amount-row">
                  <span className="label">Gallons Purchased (fleet card)</span>
                  <span className="value" style={{ color:'var(--amber)' }}>{gal(totalGal)}</span>
                </div>
                <div className="amount-row" style={{ marginBottom:0 }}>
                  <span className="label">Fleet MPG (est.)</span>
                  <span className="value" style={{ color:'var(--white)' }}>{fleetMpg.toFixed(2)}</span>
                </div>
              </>
            )}
          </div>

          {/* Per-state table */}
          <div style={{ display:'grid', gridTemplateColumns:gridCols, fontSize:10, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.06em', padding:'0 2px 6px', borderBottom:'1px solid var(--border)' }}>
            <div>STATE</div>
            <div style={{ textAlign:'right' }}>TOTAL</div>
            <div style={{ textAlign:'right' }}>LOADED</div>
            <div style={{ textAlign:'right' }}>{hasGal ? 'DH' : 'DEADHEAD'}</div>
            {hasGal && <div style={{ textAlign:'right' }}>GAL</div>}
          </div>
          {states.map(r => (
            <div key={r.state} style={{ display:'grid', gridTemplateColumns:gridCols, padding:'8px 2px', borderBottom:'1px solid rgba(255,255,255,0.05)', fontSize:12 }}>
              <div style={{ fontFamily:'var(--font-head)', fontWeight:900, color:'var(--white)' }}>{r.state}</div>
              <div style={{ textAlign:'right', color:'var(--amber)', fontWeight:700 }}>{mi(r.miles)}</div>
              <div style={{ textAlign:'right', color:'var(--green)' }}>{mi(r.loaded)}</div>
              <div style={{ textAlign:'right', color:'var(--grey)' }}>{mi(r.deadhead)}</div>
              {hasGal && <div style={{ textAlign:'right', color:'var(--white)', fontWeight:700 }}>{gal(r.est_gallons)}</div>}
            </div>
          ))}

          {/* Source + integrity notes */}
          <div style={{ fontSize:10, color:'var(--grey)', marginTop:10 }}>
            {anyOsrm
              ? 'Some legs use the OSRM fallback route (no ORS_API_KEY set). All figures are estimates for filing preparation.'
              : 'Truck-profile routed miles (ORS driving-hgv). All figures are estimates for filing preparation.'}
          </div>
          {hasGal && (
            <div style={{ fontSize:10, color:'var(--grey)', marginTop:4 }}>
              Gallons ESTIMATED: fleet-card gallons purchased this quarter carved
              across states by mile share (state miles {'\u00f7'} Fleet MPG); state
              gallons sum to gallons purchased. Reconcile against Tim{'\u2019'}s in-cab
              odometer ledger (fueling + state-line readings) before filing.
            </div>
          )}
          {hasXX && (
            <div style={{ fontSize:10, color:'var(--grey)', marginTop:4 }}>
              XX = unattributed boundary sliver, kept so state miles always sum
              to the routed total.
            </div>
          )}

          {/* IVDR — state-line odometer records (date + reading each line) */}
          {segments.length > 0 && (
            <div style={{ marginTop:12 }}>
              <button
                className="scan-btn secondary"
                style={{ width:'100%', padding:'10px', fontSize:12 }}
                onClick={(ev) => { ev.stopPropagation(); setIvdrOpen(v => !v) }}
              >
                {(ivdrOpen ? '\u25b2 ' : '\u25bc ') + 'IVDR \u2014 STATE LINE ODOMETER (' + segments.length + ')'}
              </button>
              {ivdrOpen && (
                <div style={{ marginTop:10 }}>
                  <div style={{ display:'grid', gridTemplateColumns:'62px 34px 1fr 1fr 58px', fontSize:10, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.06em', padding:'0 2px 6px', borderBottom:'1px solid var(--border)' }}>
                    <div>DATE</div>
                    <div>ST</div>
                    <div style={{ textAlign:'right' }}>ODO START</div>
                    <div style={{ textAlign:'right' }}>ODO END</div>
                    <div style={{ textAlign:'right' }}>MILES</div>
                  </div>
                  {segments.map((s, idx) => (
                    <div key={idx} style={{ display:'grid', gridTemplateColumns:'62px 34px 1fr 1fr 58px', padding:'6px 2px', borderBottom:'1px solid rgba(255,255,255,0.05)', fontSize:11, opacity: s.leg_type === 'deadhead' ? 0.75 : 1 }}>
                      <div style={{ color:'var(--grey)' }}>{(s.date || '').slice(0, 5)}</div>
                      <div style={{ fontFamily:'var(--font-head)', fontWeight:900, color: s.leg_type === 'deadhead' ? 'var(--grey)' : 'var(--white)' }}>{s.state}</div>
                      <div style={{ textAlign:'right', color:'var(--grey)' }}>{Math.round(s.odo_start).toLocaleString('en-US')}</div>
                      <div style={{ textAlign:'right', color:'var(--white)' }}>{Math.round(s.odo_end).toLocaleString('en-US')}</div>
                      <div style={{ textAlign:'right', color:'var(--amber)', fontWeight:700 }}>{mi(s.miles)}</div>
                    </div>
                  ))}
                  <div style={{ fontSize:10, color:'var(--grey)', marginTop:8 }}>
                    One row per state traversal in travel order: the reading that
                    ends one state{'\u2019'}s miles opens the next. Deadhead rows dimmed.
                    Odometer chain derived from routed miles (anchor estimated);
                    dates interpolated between pickup and delivery.
                  </div>
                </div>
              )}
              <button
                className="scan-btn"
                style={{ width:'100%', marginTop:8, padding:'10px', fontSize:12 }}
                onClick={(ev) => { ev.stopPropagation(); downloadIvdrCsv() }}
              >
                DOWNLOAD IVDR CSV
              </button>
            </div>
          )}

          <button
            className="scan-btn secondary"
            style={{ width:'100%', marginTop:10, padding:'10px', fontSize:12 }}
            disabled={loading}
            onClick={(ev) => { ev.stopPropagation(); fetchIfta() }}
          >
            {loading ? '...' : 'REFRESH'}
          </button>
        </div>
      )}
    </div>
  )
}
