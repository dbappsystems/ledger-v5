// src/IftaDailyLog.jsx
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — LIVE daily state-line odometer log (floating button).
//
// WHAT THIS IS
//   A floating button on the Loads front page. Tim taps it after a day's run
//   and logs his RAW DAILY chain: the date, his starting odometer, then each
//   state-line crossing (pick the state, type the odometer reading AT the
//   line). Miles are COMPUTED by the worker (this reading − the previous one),
//   never hand-typed, so the chain can never disagree with itself.
//
//   This is the FACT side of IFTA — the driver's own odometer, entered live —
//   sitting beside the routed ESTIMATE. It posts to POST /api/ifta/manual in
//   mode:'day', which writes ifta_segments (source='driver-manual') and
//   ifta_miles (source='manual') under a synthetic per-day load id. The
//   existing quarterly IFTA card and IVDR CSV pick these up with zero changes.
//
// PREVIEW-FIRST (mirrors the fuel-reconcile flow):
//   The first tap of SAVE runs the same endpoint WITHOUT confirm — the worker
//   validates the whole chain and returns the computed miles. The driver sees
//   the per-state result, then taps CONFIRM & SAVE to commit. A bad reading
//   (odometer going backward) is caught server-side and shown before anything
//   is written.
//
// INTEGRITY (enforced by the worker, echoed here for instant feedback):
//   Every reading must exceed the one before it. The chain opens at or above
//   the driver's highest recorded odometer — the odometer only moves forward.
//
// Floating-button pattern matches <Feedback/>: fixed, above the tab bar, only
// rendered inside the logged-in app. Rendered by App.jsx on the Loads list.
// An `inline` prop switches off the fixed positioning so the same button can
// sit inside the header row instead of floating.

import { useState } from 'react'
import { api as apiClient } from './api.js'

// 48 US IFTA jurisdictions + DC (lower 48; IFTA excludes AK/HI). Two-letter
// codes match the state attribution used everywhere else in the ledger.
const STATES = [
  'AL','AZ','AR','CA','CO','CT','DE','FL','GA','ID','IL','IN','IA','KS','KY',
  'LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY',
  'NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA',
  'WV','WI','WY','DC',
]

function todayIso() {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + mm + '-' + dd
}

export default function IftaDailyLog({ driver, showToast, inline = false }) {
  const [open,    setOpen]    = useState(false)
  const [date,    setDate]    = useState(todayIso())
  const [start,   setStart]   = useState('')
  const [rows,    setRows]    = useState([{ state: '', odometer: '' }])
  const [busy,    setBusy]    = useState(false)
  const [msg,     setMsg]     = useState('')
  const [preview, setPreview] = useState(null)   // plan object from the worker

  function reset() {
    setDate(todayIso()); setStart(''); setRows([{ state: '', odometer: '' }])
    setMsg(''); setPreview(null); setBusy(false)
  }
  function close() { setOpen(false); reset() }

  function setRow(i, key, val) {
    setRows(rs => rs.map((r, idx) => idx === i ? { ...r, [key]: val } : r))
    setPreview(null); setMsg('')
  }
  function addRow() { setRows(rs => [...rs, { state: '', odometer: '' }]); setPreview(null) }
  function removeRow(i) {
    setRows(rs => rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs)
    setPreview(null)
  }

  // Live per-row miles for on-screen feedback only — the worker recomputes and
  // is the source of truth. First row measures from the start odometer; each
  // later row from the row above it. Null until both ends are valid & forward.
  function rowMiles(i) {
    const prev = i === 0 ? parseFloat(start) : parseFloat(rows[i - 1].odometer)
    const cur  = parseFloat(rows[i].odometer)
    if (!isFinite(prev) || !isFinite(cur) || cur <= prev) return null
    return Math.round((cur - prev) * 10) / 10
  }

  function cleanRows() {
    return rows
      .filter(r => String(r.state).trim() && String(r.odometer).trim())
      .map(r => ({ state: String(r.state).toUpperCase().trim(), odometer: parseFloat(r.odometer) }))
  }

  // Client-side guardrails mirror the worker so obvious errors surface without
  // a round trip. The worker still validates authoritatively.
  function localCheck() {
    const s = parseFloat(start)
    if (!isFinite(s) || s <= 0) return 'Enter the starting odometer.'
    const rs = cleanRows()
    if (rs.length < 1) return 'Add at least one state crossing.'
    let prev = s
    for (let i = 0; i < rs.length; i++) {
      if (!(rs[i].odometer > prev)) {
        return 'Row ' + (i + 1) + ' (' + rs[i].state + '): reading must be greater than ' + prev + '.'
      }
      prev = rs[i].odometer
    }
    return ''
  }

  async function post(confirm) {
    const local = localCheck()
    if (local) { setMsg(local); return }
    setBusy(true); setMsg('')
    try {
      const res = await apiClient('/api/ifta/manual', {
        method: 'POST',
        json: {
          driver, mode: 'day', date,
          start_odometer: parseFloat(start),
          rows: cleanRows(),
          confirm,
        },
      })
      if (confirm && res && res.applied) {
        if (showToast) showToast('Logged ' + res.total_miles + ' mi across ' + res.states + ' state' + (res.states === 1 ? '' : 's') + '.')
        close()
      } else if (!confirm && res && res.preview) {
        setPreview(res.plan)
      } else {
        setMsg('Unexpected response — try again.')
      }
    } catch (err) {
      setMsg((err.message || 'Save failed').slice(0, 160))
    } finally {
      setBusy(false)
    }
  }

  const byState = preview ? preview.by_state : null

  return (
    <>
      {/* BUTTON — floating by default; inline when the `inline` prop is set */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          title="Log state-line odometer readings"
          style={{
            ...(inline
              ? { position:'static' }
              : { position:'fixed', right:16, bottom:150, zIndex:1400 }),
            display:'flex', alignItems:'center', gap:8,
            padding:'12px 16px', borderRadius:28, border:'none',
            background:'var(--amber)', color:'#0A1628',
            fontFamily:'var(--font-head)', fontWeight:900, fontSize:12,
            letterSpacing:'0.05em', cursor:'pointer',
            boxShadow:'0 4px 14px rgba(0,0,0,0.4)',
            whiteSpace:'nowrap',
          }}
        >
          <span style={{ fontSize:16, lineHeight:1 }}>{'\uD83D\uDCCD'}</span>
          LOG STATE MILES
        </button>
      )}

      {/* DRAWER */}
      {open && (
        <div
          style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:1500, display:'flex', alignItems:'flex-end', justifyContent:'center' }}
          onClick={close}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ width:'100%', maxWidth:480, maxHeight:'92dvh', overflowY:'auto', background:'var(--navy2)', borderTopLeftRadius:16, borderTopRightRadius:16, border:'1px solid var(--border)', borderBottom:'none', padding:'18px 16px 28px' }}
          >
            {/* Header */}
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4 }}>
              <div style={{ fontFamily:'var(--font-head)', fontWeight:900, fontSize:16, color:'var(--amber)', letterSpacing:'0.04em' }}>
                {'\uD83D\uDCCD'} LOG STATE MILES
              </div>
              <button onClick={close} style={{ background:'transparent', border:'none', color:'var(--grey)', fontSize:22, cursor:'pointer', lineHeight:1, padding:'0 4px' }}>{'\u00d7'}</button>
            </div>
            <div style={{ fontSize:11, color:'var(--grey)', marginBottom:16 }}>
              Log the odometer at each state line as you cross it. Miles compute
              automatically. This is the FACT record{'\u2014'}your own readings{'\u2014'}beside
              the routed estimate.
            </div>

            {/* Date + start odometer */}
            <div style={{ display:'flex', gap:10, marginBottom:14 }}>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:10, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.06em', marginBottom:5 }}>DATE</div>
                <input type="date" value={date} onChange={e => { setDate(e.target.value); setPreview(null) }}
                  style={{ width:'100%', boxSizing:'border-box', background:'var(--navy3)', border:'1px solid var(--border)', color:'var(--white)', borderRadius:8, padding:'11px 12px', fontSize:15, fontFamily:'var(--font-body)' }} />
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:10, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.06em', marginBottom:5 }}>START ODOMETER</div>
                <input type="number" inputMode="numeric" placeholder="1027459" value={start}
                  onChange={e => { setStart(e.target.value); setPreview(null); setMsg('') }}
                  style={{ width:'100%', boxSizing:'border-box', background:'var(--navy3)', border:'1px solid var(--border)', color:'var(--white)', borderRadius:8, padding:'11px 12px', fontSize:15, fontFamily:'var(--font-body)' }} />
              </div>
            </div>

            {/* Crossing rows */}
            <div style={{ fontSize:10, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.06em', marginBottom:8 }}>
              STATE-LINE CROSSINGS (in travel order)
            </div>
            {rows.map((r, i) => {
              const m = rowMiles(i)
              return (
                <div key={i} style={{ display:'flex', gap:8, alignItems:'center', marginBottom:8 }}>
                  <select value={r.state} onChange={e => setRow(i, 'state', e.target.value)}
                    style={{ flex:'0 0 84px', background:'var(--navy3)', border:'1px solid var(--border)', color:r.state ? 'var(--white)' : 'var(--grey)', borderRadius:8, padding:'11px 8px', fontSize:15, fontFamily:'var(--font-head)', fontWeight:700 }}>
                    <option value="">ST</option>
                    {STATES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <input type="number" inputMode="numeric" placeholder="odometer at line" value={r.odometer}
                    onChange={e => setRow(i, 'odometer', e.target.value)}
                    style={{ flex:1, minWidth:0, boxSizing:'border-box', background:'var(--navy3)', border:'1px solid var(--border)', color:'var(--white)', borderRadius:8, padding:'11px 12px', fontSize:15, fontFamily:'var(--font-body)' }} />
                  <div style={{ flex:'0 0 58px', textAlign:'right', fontSize:12, fontFamily:'var(--font-head)', fontWeight:700, color: m == null ? 'var(--grey)' : 'var(--amber)' }}>
                    {m == null ? '\u2014' : m + ' mi'}
                  </div>
                  <button onClick={() => removeRow(i)} disabled={rows.length <= 1}
                    style={{ flex:'0 0 auto', background:'transparent', border:'none', color: rows.length <= 1 ? '#444' : 'var(--grey)', fontSize:18, cursor: rows.length <= 1 ? 'default' : 'pointer', padding:'0 2px', lineHeight:1 }}>{'\u2212'}</button>
                </div>
              )
            })}

            <button onClick={addRow}
              style={{ width:'100%', marginTop:2, marginBottom:14, padding:'10px', borderRadius:8, border:'1px dashed var(--border)', background:'transparent', color:'var(--grey)', fontFamily:'var(--font-head)', fontWeight:700, fontSize:12, letterSpacing:'0.05em', cursor:'pointer' }}>
              + ADD STATE CROSSING
            </button>

            {/* Preview result */}
            {preview && (
              <div style={{ background:'var(--navy3)', borderRadius:10, padding:'12px 14px', marginBottom:14, border:'1px solid var(--amber)' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:8 }}>
                  <span style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.06em' }}>PREVIEW</span>
                  <span style={{ fontSize:18, fontFamily:'var(--font-head)', fontWeight:900, color:'var(--amber)' }}>{preview.total_miles} mi</span>
                </div>
                {Object.keys(byState).map(st => (
                  <div key={st} style={{ display:'flex', justifyContent:'space-between', fontSize:13, padding:'3px 0' }}>
                    <span style={{ fontFamily:'var(--font-head)', fontWeight:700, color:'var(--white)' }}>{st}</span>
                    <span style={{ color:'var(--amber)', fontWeight:700 }}>{byState[st]} mi</span>
                  </div>
                ))}
                <div style={{ fontSize:10, color:'var(--grey)', marginTop:8 }}>
                  {preview.first_odometer} {'\u2192'} {preview.last_odometer}. Confirm to save
                  these readings as fact for {preview.entry_date}.
                </div>
              </div>
            )}

            {msg && (
              <div style={{ fontSize:12, color:'#e53935', fontFamily:'var(--font-head)', fontWeight:700, marginBottom:12 }}>{'\u26a0\ufe0f '}{msg}</div>
            )}

            {/* Actions */}
            {!preview ? (
              <button onClick={() => post(false)} disabled={busy}
                style={{ width:'100%', padding:'15px 0', borderRadius:10, border:'none', background: busy ? '#555' : 'var(--amber)', color: busy ? '#aaa' : '#0A1628', fontFamily:'var(--font-head)', fontWeight:900, fontSize:15, letterSpacing:'0.05em', cursor: busy ? 'default' : 'pointer' }}>
                {busy ? 'CHECKING\u2026' : 'PREVIEW MILES'}
              </button>
            ) : (
              <div style={{ display:'flex', gap:10 }}>
                <button onClick={() => setPreview(null)} disabled={busy}
                  style={{ flex:'0 0 40%', padding:'15px 0', borderRadius:10, border:'1px solid var(--border)', background:'transparent', color:'var(--grey)', fontFamily:'var(--font-head)', fontWeight:700, fontSize:14, cursor:'pointer' }}>
                  EDIT
                </button>
                <button onClick={() => post(true)} disabled={busy}
                  style={{ flex:1, padding:'15px 0', borderRadius:10, border:'none', background: busy ? '#555' : 'var(--green)', color: busy ? '#aaa' : '#0A1628', fontFamily:'var(--font-head)', fontWeight:900, fontSize:15, letterSpacing:'0.05em', cursor: busy ? 'default' : 'pointer' }}>
                  {busy ? 'SAVING\u2026' : 'CONFIRM & SAVE'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
