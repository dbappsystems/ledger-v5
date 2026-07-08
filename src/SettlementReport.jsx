// src/SettlementReport.jsx
// (c) dbappsystems.com 
// Load Ledger V5 — Settlement Report
//
// AUTH MIGRATION: all 10 calls go through the token api() client. The `api`
// URL prop is gone.
//
// PER-TENANT SPLIT: the deleted BRUCE_CUT/TIM_CUT constants are replaced by the
// per-tenant ownerCutPct prop. The driver's take is base*(1-ownerCut) — verified
// identical to v4 (base*TIM_CUT 0.90) at the default 10% split. App.jsx passes
// ownerCutPct from tenant settings; default 10 keeps Edgerton unchanged.
//
// WHITE-LABEL: driver list, per-driver colors, fuel/advance fetches, and the
// statement header color are all driven by the tenant's drivers via useDrivers()
// (falls back to the seeded BRUCE/TIM). Escrow stays TIM-specific — it's the
// Edgerton ETTR financing tracker, a client-specific concern out of scope here.
// The statement overlay still hardcodes the company name "Edgerton Truck &
// Trailer Repair"; that becomes tenant branding in a later pass.
//
// ACCOUNTING MODEL: "Still Owed" is an all-time RUNNING BALANCE (not period-reset).
// Period filters control which activity rows display; the bottom-line balance is
// always the full picture: all earned − all fuel − all ACH − all escrow.
//
// WEEKLY PAYSTUB: each driver card also opens DriverPaystub.jsx — a read-only
// Monday–Monday settlement stub (plain black ink). It reuses settlementMath so
// its numbers tie to billing; it writes nothing.

import { useState, useRef } from 'react'
import { api as apiClient } from './api.js'
import { useDrivers } from './useDrivers.js'
import DriverPaystub from './DriverPaystub.jsx'
import DrilldownOverlay from './DrilldownOverlay.jsx'
import { buildDrilldown } from './settlementDrilldown.js'
import {
  normalizeOwnerCut, asArray, parseAppDate, loadDate,
  getLoadTotals, calcPay, advanceKept, reimbursementOwed,
  computeRunningBalance, carrierAdvanceOwed,
} from './settlementMath'

// -- FORMATTERS --------------------------------------------------------
function fmt(n) { return '$' + (parseFloat(n)||0).toFixed(2) }

// -- DATE / PERIOD HELPERS ---------------------------------------------
function inPeriodByDate(dateStr, p, offset) {
  if (!dateStr) return false
  const d = parseAppDate(dateStr)
  if (!d) return false
  const now = new Date()
  if (p === 'daily') {
    const target = new Date(now); target.setDate(target.getDate() + offset)
    return d.toDateString() === target.toDateString()
  }
  if (p === 'weekly') {
    const end = new Date(now); end.setDate(end.getDate() + offset * 7); end.setHours(23,59,59,999)
    const start = new Date(end); start.setDate(end.getDate() - 6); start.setHours(0,0,0,0)
    return d >= start && d <= end
  }
  if (p === 'monthly') {
    const target = new Date(now.getFullYear(), now.getMonth() + offset, 1)
    return d.getMonth() === target.getMonth() && d.getFullYear() === target.getFullYear()
  }
  if (p === 'yearly') return d.getFullYear() === now.getFullYear() + offset
  return false
}

function getPeriodLabel(p, offset) {
  const now = new Date()
  if (p === 'daily') {
    const target = new Date(now); target.setDate(target.getDate() + offset)
    if (offset === 0) return 'TODAY'
    if (offset === -1) return 'YESTERDAY'
    return target.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' }).toUpperCase()
  }
  if (p === 'weekly') {
    const end = new Date(now); end.setDate(end.getDate() + offset * 7)
    const start = new Date(end); start.setDate(end.getDate() - 6)
    return start.toLocaleDateString('en-US', { month:'short', day:'numeric' }).toUpperCase()
      + ' - ' + end.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }).toUpperCase()
  }
  if (p === 'monthly') {
    const target = new Date(now.getFullYear(), now.getMonth() + offset, 1)
    return target.toLocaleDateString('en-US', { month:'long', year:'numeric' }).toUpperCase()
  }
  if (p === 'yearly') return String(now.getFullYear() + offset)
  return ''
}

// -- LOAD HELPERS -------------------------------------------------------
// loadDate / getLoadTotals / calcPay / advanceKept / reimbursementOwed
// now live in src/settlementMath.js — imported above.
function inPeriod(load, p, offset) {
  const dateStr = loadDate(load)
  if (!dateStr) return false
  return inPeriodByDate(dateStr, p, offset)
}

// -- FIFO SOURCE OF FUNDS — display-only audit trail --------------------
// Traces every payout (fleet fuel, ACH, escrow) to the oldest earnings
// still unclaimed at that point — first in, first out, the way an auditor
// reads a ledger. Pure render-time math on records that already exist.
// Does NOT change the running balance — stillOwed stays authoritative.
function monthKey(d) {
  return d.toLocaleDateString('en-US', { month:'short', year:'numeric' }).toUpperCase()
}

function buildFifoLedger(dLoads, driverFuel, driverEscrow, ownerCutPct, driverPayments) {
  const credits = []
  const debits  = []
  // CREDITS: each load's net earnings at its delivery date
  // (driver net pay − comdata advance kept + lumper reimbursement)
  dLoads.forEach(l => {
    const dt  = parseAppDate(loadDate(l)) || new Date(0)
    const net = calcPay(l, ownerCutPct).driverNet - advanceKept(l) + reimbursementOwed(l)
    if (net > 0.005) {
      credits.push({ date: dt, month: monthKey(dt), amount: net })
    } else if (net < -0.005) {
      // Rare: comdata advance exceeded the load's pay — treat as a payout
      debits.push({ date: dt, type:'ADV', label:'Advance over earnings — Load ' + (l.load_number || '-'), amount: -net })
    }
    // DEBIT: ACH payment disbursed against this load
    if (l.ach_payment) {
      const recv = parseFloat(l.ach_received) || 0
      if (recv > 0.005) debits.push({ date: dt, type:'ACH', label:'ACH — Load ' + (l.load_number || '-'), amount: recv })
    }
  })
  // DEBITS: fleet card fuel at entry date
  driverFuel.forEach(f => {
    if (f.fuel_type !== 'fleet') return
    const amt = parseFloat(f.amount) || 0
    if (amt <= 0.005) return
    const dt = parseAppDate(f.entry_date) || new Date(0)
    debits.push({ date: dt, type:'FUEL', label:'Fleet Fuel', amount: amt })
  })
  // DEBITS: escrow draws at funded date
  driverEscrow.forEach(p => {
    const amt = parseFloat(p.amount) || 0
    if (amt <= 0.005) return
    const dt = parseAppDate(p.funded_at) || new Date(0)
    debits.push({ date: dt, type:'ETTR', label:'ETTR Financed Repair Payment', amount: amt })
  })
  // DEBITS: cash/check paid directly to the driver (settlement_payments) at paid_at.
  // Consumes oldest unpaid earnings first, exactly like ACH — same dollars the
  // running balance subtracts, so the FIFO audit trail reconciles to the balance.
  ;(Array.isArray(driverPayments) ? driverPayments : []).forEach(p => {
    const amt = parseFloat(p.amount) || 0
    if (amt <= 0.005) return
    const dt = parseAppDate(p.paid_at) || new Date(0)
    const method = (p.method || 'payment').toUpperCase()
    const ref = p.reference ? ' #' + p.reference : ''
    debits.push({ date: dt, type:'PAY', label:'Driver Paid (' + method + ')' + ref, amount: amt })
  })
  credits.sort((a,b) => a.date - b.date)
  debits.sort((a,b) => a.date - b.date)

  // FIFO allocation: each payout consumes the oldest unclaimed earnings
  let ci = 0
  let creditLeft = credits.length > 0 ? credits[0].amount : 0
  const debitRows = []
  let unfunded = 0
  debits.forEach(db => {
    let need = db.amount
    const sources = {}
    while (need > 0.005 && ci < credits.length) {
      const take = Math.min(need, creditLeft)
      sources[credits[ci].month] = (sources[credits[ci].month] || 0) + take
      need       -= take
      creditLeft -= take
      if (creditLeft <= 0.005) {
        ci++
        creditLeft = ci < credits.length ? credits[ci].amount : 0
      }
    }
    if (need > 0.005) { sources['AHEAD OF EARNINGS'] = (sources['AHEAD OF EARNINGS'] || 0) + need; unfunded += need }
    debitRows.push({ date: db.date, type: db.type, label: db.label, amount: db.amount, sources })
  })
  // Whatever earnings were never consumed = the balance owed, by month
  const unpaid = {}
  if (ci < credits.length && creditLeft > 0.005) unpaid[credits[ci].month] = creditLeft
  for (let j = ci + 1; j < credits.length; j++) {
    unpaid[credits[j].month] = (unpaid[credits[j].month] || 0) + credits[j].amount
  }
  return { debitRows, unpaid, unfunded }
}

// Display compaction only: merge individual fleet-fuel debits into one
// row per month. The FIFO allocation above already ran per entry — this
// merges display rows; sources merge cleanly (month-labeled amounts).
function mergeFuelRowsByMonth(debitRows) {
  const out = []
  const fuelByMonth = {}
  debitRows.forEach(r => {
    if (r.type !== 'FUEL') { out.push(r); return }
    const key = monthKey(r.date)
    if (!fuelByMonth[key]) {
      fuelByMonth[key] = { date: r.date, type:'FUEL', label:'Fleet Fuel — ' + key, amount: 0, sources: {} }
      out.push(fuelByMonth[key])
    }
    fuelByMonth[key].amount += r.amount
    Object.keys(r.sources).forEach(m => {
      fuelByMonth[key].sources[m] = (fuelByMonth[key].sources[m] || 0) + r.sources[m]
    })
  })
  return out
}

function fmtSources(sources) {
  const keys = Object.keys(sources)
  if (keys.length === 0) return '-'
  return keys.map(m => m + ' ' + fmt(sources[m])).join(' + ')
}

// -- B&W SCANNER PIPELINE — LOCKED DO NOT MODIFY ----------------------
function isPDF(file) { return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf') }

async function renderPdfToCanvas(file) {
  const pdfjsLib = window.pdfjsLib
  if (!pdfjsLib) throw new Error('PDF.js not loaded')
  const arrayBuf = await file.arrayBuffer()
  const pdf      = await pdfjsLib.getDocument({ data: arrayBuf }).promise
  const page     = await pdf.getPage(1)
  const MAX      = 1200
  const baseVP   = page.getViewport({ scale: 1 })
  const scale    = Math.min(MAX / baseVP.width, MAX / baseVP.height, 2.0)
  const viewport = page.getViewport({ scale })
  const canvas   = document.createElement('canvas')
  canvas.width   = Math.round(viewport.width)
  canvas.height  = Math.round(viewport.height)
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
  return canvas
}

function applyBWPipeline(canvas) {
  const w = canvas.width, h = canvas.height
  const ctx = canvas.getContext('2d')
  const id = ctx.getImageData(0, 0, w, h)
  const data = id.data
  const gray = new Uint8ClampedArray(w * h)
  for (let i = 0; i < gray.length; i++) {
    const p = i * 4
    gray[i] = Math.round(0.299 * data[p] + 0.587 * data[p+1] + 0.114 * data[p+2])
  }
  let mn = 255, mx = 0
  for (let i = 0; i < gray.length; i++) { if (gray[i] < mn) mn = gray[i]; if (gray[i] > mx) mx = gray[i] }
  const range = mx - mn || 1
  for (let i = 0; i < gray.length; i++) gray[i] = Math.round(((gray[i] - mn) / range) * 255)
  const kernel = [1,2,1, 2,4,2, 1,2,1], kSum = 16
  const blurred = new Uint8ClampedArray(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0, ki = 0
    for (let ky = -1; ky <= 1; ky++) for (let kx = -1; kx <= 1; kx++) {
      const nx = Math.min(Math.max(x + kx, 0), w - 1)
      const ny = Math.min(Math.max(y + ky, 0), h - 1)
      sum += gray[ny * w + nx] * kernel[ki++]
    }
    blurred[y * w + x] = Math.round(sum / kSum)
  }
  const S = Math.floor(Math.max(w, h) / 16), T = 0.15
  const integ = new Int32Array(w * h)
  for (let y = 0; y < h; y++) {
    let rowSum = 0
    for (let x = 0; x < w; x++) {
      rowSum += blurred[y * w + x]
      integ[y * w + x] = rowSum + (y > 0 ? integ[(y-1)*w+x] : 0)
    }
  }
  const bw = new Uint8ClampedArray(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x1 = Math.max(x-S,0), y1 = Math.max(y-S,0)
    const x2 = Math.min(x+S,w-1), y2 = Math.min(y+S,h-1)
    const count = (x2-x1)*(y2-y1)
    const sum = integ[y2*w+x2]
      - (x1>0 ? integ[y2*w+(x1-1)] : 0)
      - (y1>0 ? integ[(y1-1)*w+x2] : 0)
      + (x1>0&&y1>0 ? integ[(y1-1)*w+(x1-1)] : 0)
    bw[y*w+x] = (blurred[y*w+x]*count) < (sum*(1-T)) ? 0 : 255
  }
  const sharp = new Uint8ClampedArray(w * h)
  for (let i = 0; i < bw.length; i++) sharp[i] = Math.min(255, Math.max(0, Math.round(bw[i] + 1.5 * (bw[i] - blurred[i]))))
  for (let i = 0; i < sharp.length; i++) {
    const p = i * 4
    data[p] = data[p+1] = data[p+2] = sharp[i]; data[p+3] = 255
  }
  ctx.putImageData(id, 0, 0)
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
  return { dataUrl, base64: dataUrl.split(',')[1] }
}

async function processFile(file) {
  let canvas
  if (isPDF(file)) {
    canvas = await renderPdfToCanvas(file)
  } else {
    canvas = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = reject
      reader.onload = (ev) => {
        const img = new Image()
        img.onerror = reject
        img.onload = () => {
          const MAX = 1200
          let w = img.naturalWidth || img.width || 800
          let h = img.naturalHeight || img.height || 1000
          if (w > MAX) { h = Math.round(h * MAX / w); w = MAX }
          if (h > MAX) { w = Math.round(w * MAX / h); h = MAX }
          const c = document.createElement('canvas')
          c.width = w; c.height = h
          c.getContext('2d').drawImage(img, 0, 0, w, h)
          resolve(c)
        }
        img.src = ev.target.result
      }
      reader.readAsDataURL(file)
    })
  }
  return applyBWPipeline(canvas)
}

function toBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload  = () => res(r.result.split(',')[1])
    r.onerror = rej
    r.readAsDataURL(file)
  })
}

// -- FULL STATEMENT OVERLAY --------------------------------------------
function StatementOverlay({ data, driverName, headerColor, onClose }) {
  const d = data
  const statementBodyRef = useRef(null)
  const [pdfBusy, setPdfBusy] = useState(false)

  // Load a script from cdnjs on demand (cached after first load).
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[data-ll="' + src + '"]')) return resolve()
      const s = document.createElement('script')
      s.src = src
      s.async = true
      s.setAttribute('data-ll', src)
      s.onload = () => resolve()
      s.onerror = () => reject(new Error('Failed to load ' + src))
      document.head.appendChild(s)
    })
  }

  async function downloadStatementPdf() {
    if (pdfBusy) return
    setPdfBusy(true)
    try {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js')
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js')
      const html2canvas = window.html2canvas
      const jsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF
      const node = statementBodyRef.current
      if (!node || !html2canvas || !jsPDF) throw new Error('PDF tools unavailable')

      const canvas = await html2canvas(node, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true,
        windowWidth: node.scrollWidth,
        windowHeight: node.scrollHeight,
      })

      const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' })
      const pageW = pdf.internal.pageSize.getWidth()
      const pageH = pdf.internal.pageSize.getHeight()
      const margin = 28                       // top + bottom + side breathing room on every page
      const imgW = pageW - margin * 2          // printable width in PDF points
      const usableH = pageH - margin * 2       // printable height in PDF points
      // pixels of the source canvas that fit on one page at this width
      const pxPerPage = Math.floor((usableH * canvas.width) / imgW)

      // Find a clean horizontal break at or before `target` px: scan upward for a
      // near-white row (the gap between table rows) so a page never cuts through
      // text. Falls back to the hard target only if no gap is found in range.
      const ctxScan = canvas.getContext('2d')
      function isBlankRow(y) {
        // sample across the width; treat the row as blank if every sample is light
        const row = ctxScan.getImageData(0, y, canvas.width, 1).data
        const step = 4 * 8                     // sample every 8th pixel for speed
        for (let x = 0; x < row.length; x += step) {
          if (row[x] < 244 || row[x + 1] < 244 || row[x + 2] < 244) return false
        }
        return true
      }
      function findBreak(target) {
        if (target >= canvas.height) return canvas.height
        const minY = target - Math.floor(pxPerPage * 0.30)   // don't back up more than 30% of a page
        for (let y = target; y >= Math.max(minY, 1); y--) {
          if (isBlankRow(y)) return y
        }
        return target                                        // no gap found — cut at target
      }

      let sliceTop = 0
      let first = true
      while (sliceTop < canvas.height) {
        const rawTarget = sliceTop + pxPerPage
        const sliceBottom = findBreak(Math.min(rawTarget, canvas.height))
        const sliceH = sliceBottom - sliceTop
        // draw this slice onto its own canvas so it lands top-anchored with margins
        const pageCanvas = document.createElement('canvas')
        pageCanvas.width = canvas.width
        pageCanvas.height = sliceH
        const pctx = pageCanvas.getContext('2d')
        pctx.fillStyle = '#ffffff'
        pctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height)
        pctx.drawImage(canvas, 0, sliceTop, canvas.width, sliceH, 0, 0, canvas.width, sliceH)
        const sliceImgH = (sliceH * imgW) / canvas.width      // PDF-point height of this slice
        if (!first) pdf.addPage()
        pdf.addImage(pageCanvas.toDataURL('image/png'), 'PNG', margin, margin, imgW, sliceImgH)
        first = false
        sliceTop = sliceBottom
        if (sliceH <= 0) break                                // safety: never loop forever
      }

      const safeName = String(driverName || 'driver').replace(/[^a-z0-9]+/gi, '_')
      const fileName = 'settlement_' + safeName + '_' + (d.periodLabel || '').replace(/[^a-z0-9]+/gi, '_') + '.pdf'

      const blob = pdf.output('blob')
      const file = new File([blob], fileName, { type: 'application/pdf' })
      // iPhone: use the native share sheet when available (Save to Files, Print, AirDrop).
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: fileName })
          return
        } catch (shareErr) {
          if (shareErr && shareErr.name === 'AbortError') return
          // fall through to download
        }
      }
      // Desktop / fallback: trigger a normal download.
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 4000)
    } catch (err) {
      alert('Could not generate PDF: ' + (err && err.message ? err.message : 'unknown error'))
    } finally {
      setPdfBusy(false)
    }
  }
  const TH  = { background:'#1a2a3a', color:'#fff', padding:'8px 10px', fontSize:11, fontWeight:700, textAlign:'left', fontFamily:'var(--font-head)', letterSpacing:'0.04em' }
  const TD  = { padding:'8px 10px', fontSize:12, borderBottom:'1px solid #e8e8e8', color:'#222', verticalAlign:'middle' }
  const TDr = { ...TD, textAlign:'right', fontFamily:'var(--font-head)', fontWeight:600 }
  const TF  = { ...TD, background:'#f0f0f0', fontWeight:700, color:'#111' }
  const TFr = { ...TF, textAlign:'right', fontFamily:'var(--font-head)' }
  return (
    <div style={{ position:'fixed', top:0, left:0, right:0, bottom:0, background:'#fff', zIndex:9999, overflowY:'auto', WebkitOverflowScrolling:'touch' }}>
      <div style={{ position:'sticky', top:0, background:'#1a2a3a', padding:'12px 16px', display:'flex', alignItems:'center', justifyContent:'space-between', zIndex:10 }}>
        <div>
          <div style={{ fontSize:11, color:'rgba(255,255,255,0.6)', fontFamily:'var(--font-head)', letterSpacing:'0.08em' }}>SETTLEMENT STATEMENT</div>
          <div style={{ fontSize:16, fontFamily:'var(--font-head)', fontWeight:900, color: headerColor || '#64b5f6' }}>{driverName}</div>
          <div style={{ fontSize:10, color:'rgba(255,255,255,0.5)', fontFamily:'var(--font-head)', letterSpacing:'0.06em', marginTop:2 }}>PERIOD ACTIVITY: {d.periodLabel}</div>
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <button onClick={downloadStatementPdf} disabled={pdfBusy} style={{ background: pdfBusy ? 'rgba(255,255,255,0.1)' : '#2e7d32', border:'none', color:'#fff', borderRadius:8, padding:'8px 16px', fontSize:14, fontFamily:'var(--font-head)', fontWeight:700, cursor: pdfBusy ? 'default' : 'pointer', opacity: pdfBusy ? 0.7 : 1 }}>{pdfBusy ? 'BUILDING…' : 'DOWNLOAD PDF'}</button>
          <button onClick={onClose} style={{ background:'rgba(255,255,255,0.15)', border:'none', color:'#fff', borderRadius:8, padding:'8px 16px', fontSize:14, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }}>X CLOSE</button>
        </div>
      </div>
      <div ref={statementBodyRef} style={{ padding:'16px', maxWidth:600, margin:'0 auto', background:'#fff' }}>
        <div style={{ background:'#f8f8f8', borderRadius:8, padding:'12px 14px', marginBottom:16, border:'1px solid #e0e0e0' }}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, fontSize:12, color:'#444' }}>
            <div><span style={{ color:'#888', fontSize:11 }}>COMPANY</span><br /><strong>Edgerton Truck &amp; Trailer Repair</strong></div>
            <div><span style={{ color:'#888', fontSize:11 }}>DRIVER</span><br /><strong>{driverName}</strong></div>
            <div><span style={{ color:'#888', fontSize:11 }}>PERIOD SHOWN</span><br /><strong>{d.periodLabel}</strong></div>
            <div><span style={{ color:'#888', fontSize:11 }}>GENERATED</span><br /><strong>{d.generated}</strong></div>
          </div>
        </div>

        {/* PERIOD EARNINGS */}
        <div style={{ marginBottom:16 }}>
          <div style={{ fontSize:12, fontWeight:900, color:'#1a2a3a', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:6, paddingLeft:4 }}>PERIOD EARNINGS (BY DELIVERY DATE)</div>
          <div style={{ borderRadius:8, border:'1px solid #e0e0e0', overflow:'hidden' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
              <thead><tr>
                <th style={TH}>Load #</th>
                <th style={{...TH,textAlign:'right'}}>Rate Con</th>
                <th style={{...TH,textAlign:'right'}}>Driver Pay</th>
                {d.totalDetention > 0 && <th style={{...TH,textAlign:'right'}}>Detention</th>}
                <th style={{...TH,textAlign:'right'}}>Earned</th>
              </tr></thead>
              <tbody>
                {d.earningsRows.map((r,i) => (
                  <tr key={i} style={{ background:i%2===0?'#fff':'#fafafa' }}>
                    <td style={TD}><strong>{r.loadNum}</strong>{r.isAch && <span style={{ marginLeft:6, fontSize:9, background:'#e8f5e9', color:'#2e7d32', padding:'1px 5px', borderRadius:3, fontWeight:700 }}>ACH</span>}</td>
                    <td style={TDr}>{fmt(r.base)}</td>
                    <td style={TDr}>{fmt(r.gross90)}</td>
                    {d.totalDetention > 0 && <td style={{...TDr,color:r.det>0?'#2e7d32':'#aaa'}}>{r.det>0?fmt(r.det):'-'}</td>}
                    <td style={{...TDr,fontWeight:700}}>{fmt(r.earned)}</td>
                  </tr>
                ))}
                <tr>
                  <td style={TF}>PERIOD TOTAL</td>
                  <td style={TFr}>{fmt(d.totalRateCon)}</td>
                  <td style={TFr}>{fmt(d.totalGross90)}</td>
                  {d.totalDetention > 0 && <td style={{...TFr,color:'#2e7d32'}}>{fmt(d.totalDetention)}</td>}
                  <td style={{...TFr,color:'#1a2a3a'}}>{fmt(d.totalEarned)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* ADVANCES */}
        {d.advRows.length > 0 && (
          <div style={{ marginBottom:16 }}>
            <div style={{ fontSize:12, fontWeight:900, color:'#1a2a3a', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:6, paddingLeft:4 }}>ADVANCES &amp; REIMBURSEMENTS</div>
            <div style={{ borderRadius:8, border:'1px solid #e0e0e0', overflow:'hidden' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead><tr>
                  <th style={TH}>Load #</th>
                  <th style={{...TH,textAlign:'right'}}>Comdata</th>
                  <th style={{...TH,textAlign:'right'}}>Lumpers+Inc</th>
                  <th style={{...TH,textAlign:'right'}}>Adv Kept</th>
                  <th style={{...TH,textAlign:'right'}}>Reimb</th>
                </tr></thead>
                <tbody>
                  {d.advRows.map((r,i) => (
                    <tr key={i} style={{ background:i%2===0?'#fff':'#fafafa' }}>
                      <td style={TD}><strong>{r.loadNum}</strong></td>
                      <td style={TDr}>{fmt(r.comdata)}</td>
                      <td style={TDr}>{fmt(r.expenses)}</td>
                      <td style={{...TDr,color:r.advKept>0?'#388e3c':'#aaa'}}>{r.advKept>0?fmt(r.advKept):'-'}</td>
                      <td style={{...TDr,color:r.reimb>0?'#f57c00':'#aaa'}}>{r.reimb>0?fmt(r.reimb):'-'}</td>
                    </tr>
                  ))}
                  <tr>
                    <td style={TF} colSpan={3}>TOTAL</td>
                    <td style={{...TFr,color:'#388e3c'}}>{fmt(d.totalAdvKept)}</td>
                    <td style={{...TFr,color:'#f57c00'}}>{fmt(d.totalReimb)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ACH */}
        {d.achLoads.length > 0 && (
          <div style={{ marginBottom:16 }}>
            <div style={{ fontSize:12, fontWeight:900, color:'#1a2a3a', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:6, paddingLeft:4 }}>ACH PAYMENTS</div>
            <div style={{ borderRadius:8, border:'1px solid #e0e0e0', overflow:'hidden' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead><tr>
                  <th style={TH}>Load #</th>
                  <th style={{...TH,textAlign:'right'}}>Invoice Amt</th>
                  <th style={{...TH,textAlign:'right'}}>Received</th>
                  <th style={{...TH,textAlign:'right'}}>Broker Fee</th>
                </tr></thead>
                <tbody>
                  {d.achLoads.map((l,i) => {
                    const netPay   = parseFloat(l.netPay||l.net_pay)||0
                    const received = parseFloat(l.ach_received)||0
                    const fee      = Math.max(0, netPay - received)
                    return (
                      <tr key={i} style={{ background:i%2===0?'#fff':'#fafafa' }}>
                        <td style={TD}><strong>{l.load_number||'-'}</strong></td>
                        <td style={TDr}>{fmt(netPay)}</td>
                        <td style={{...TDr,color:'#2e7d32'}}>{fmt(received)}</td>
                        <td style={{...TDr,color:'#e65100'}}>{fee>0?fmt(fee):'-'}</td>
                      </tr>
                    )
                  })}
                  <tr>
                    <td style={TF} colSpan={2}>TOTAL</td>
                    <td style={{...TFr,color:'#2e7d32'}}>{fmt(d.totalAchDisbursed)}</td>
                    <td style={{...TFr,color:'#e65100'}}>{fmt(d.totalAchFees)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* FUEL */}
        {d.fuelInRange.length > 0 && (
          <div style={{ marginBottom:16 }}>
            <div style={{ fontSize:12, fontWeight:900, color:'#1a2a3a', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:6, paddingLeft:4 }}>FUEL (PERIOD)</div>
            <div style={{ borderRadius:8, border:'1px solid #e0e0e0', overflow:'hidden' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead><tr>
                  <th style={TH}>Date</th><th style={TH}>Type</th><th style={TH}>Notes</th>
                  <th style={{...TH,textAlign:'right'}}>Amount</th>
                </tr></thead>
                <tbody>
                  {d.fuelInRange.map((f,i) => (
                    <tr key={i} style={{ background:i%2===0?'#fff':'#fafafa' }}>
                      <td style={TD}>{f.entry_date}</td>
                      <td style={TD}><span style={{ fontSize:10, fontWeight:700, padding:'2px 6px', borderRadius:4, background:f.fuel_type==='fleet'?'#fff3e0':'#e3f2fd', color:f.fuel_type==='fleet'?'#e65100':'#1565c0' }}>{f.fuel_type==='fleet'?'FLEET':'POCKET'}</span></td>
                      <td style={{...TD,color:'#666',fontSize:11}}>{f.notes||'-'}</td>
                      <td style={{...TDr,color:f.fuel_type==='fleet'?'#c62828':'#1565c0'}}>{fmt(f.amount)}</td>
                    </tr>
                  ))}
                  {d.fleetFuelTotal > 0 && <tr style={{background:'#fff8f8'}}><td style={TF} colSpan={3}>Fleet Card Total (period)</td><td style={{...TFr,color:'#c62828'}}>{fmt(d.fleetFuelTotal)}</td></tr>}
                  {d.pocketFuelTotal > 0 && <tr style={{background:'#f0f4ff'}}><td style={{...TF,color:'#1565c0'}} colSpan={3}>Out of Pocket Total (tax expense only)</td><td style={{...TFr,color:'#1565c0'}}>{fmt(d.pocketFuelTotal)}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* RUNNING BALANCE SUMMARY */}
        <div style={{ marginBottom:24 }}>
          <div style={{ fontSize:12, fontWeight:900, color:'#1a2a3a', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:6, paddingLeft:4 }}>RUNNING BALANCE — ALL TIME</div>
          <div style={{ background:'#fff8e1', border:'1px solid #ffe082', borderRadius:8, padding:'10px 14px', marginBottom:8, fontSize:11, color:'#7a5c00' }}>
            The running balance reflects ALL loads, fuel, ACH payments, and ETTR financed repair payments ever recorded — not just this period. This is what is currently owed.
          </div>
          <div style={{ borderRadius:8, border:'1px solid #e0e0e0', overflow:'hidden' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <tbody>
                <tr><td style={TD}>Gross Pay — All Loads (driver split of rate con)</td><td style={TDr}>{fmt(d.allGrossCompanyShare)}</td></tr>
                {d.allDetention > 0 && <tr style={{background:'#f1f8e9'}}><td style={{...TD,color:'#2e7d32'}}>+ Detention (all time)</td><td style={{...TDr,color:'#2e7d32'}}>{fmt(d.allDetention)}</td></tr>}
                {d.allAdvKept > 0 && <tr style={{background:'#fafafa'}}><td style={TD}>- Broker Advance (Comdata) (all time)</td><td style={{...TDr,color:'#c62828'}}>({fmt(d.allAdvKept)})</td></tr>}
                {d.allReimb > 0 && <tr style={{background:'#fffde7'}}><td style={{...TD,color:'#f57c00'}}>+ Lumper Reimbursements (all time)</td><td style={{...TDr,color:'#f57c00'}}>{fmt(d.allReimb)}</td></tr>}
                {d.allFleetFuel > 0 && <tr style={{background:'#fafafa'}}><td style={TD}>- Fleet Card Fuel (all time)</td><td style={{...TDr,color:'#c62828'}}>({fmt(d.allFleetFuel)})</td></tr>}
                {d.allAchDisbursed > 0 && <tr style={{background:'#e8f5e9'}}><td style={{...TD,color:'#2e7d32'}}>- ACH Payments Made (all time)</td><td style={{...TDr,color:'#2e7d32'}}>({fmt(d.allAchDisbursed)})</td></tr>}
                {d.allCarrierAdvance > 0 && <tr style={{background:'#fff3e0'}}><td style={{...TD,color:'#e65100'}}>- Carrier Advance (unrepaid, all time)</td><td style={{...TDr,color:'#e65100'}}>({fmt(d.allCarrierAdvance)})</td></tr>}
                {d.allEscrow > 0 && <tr style={{background:'#f3e5f5'}}><td style={{...TD,color:'#7b1fa2'}}>- ETTR Financed Repair Payments</td><td style={{...TDr,color:'#7b1fa2'}}>({fmt(d.allEscrow)})</td></tr>}
                <tr style={{background:'#1a2a3a'}}>
                  <td style={{ padding:'14px 12px', fontSize:15, fontWeight:900, color:'#fff', fontFamily:'var(--font-head)', letterSpacing:'0.04em' }}>BALANCE CURRENTLY OWED TO {driverName}</td>
                  <td style={{ padding:'14px 12px', textAlign:'right', fontSize:20, fontWeight:900, color:'#ffd54f', fontFamily:'var(--font-head)' }}>{fmt(d.stillOwed)}</td>
                </tr>
                {d.totalAchFees > 0 && <tr style={{background:'#fff3e0'}}><td style={{...TD,color:'#e65100',fontSize:11}}>ACH Convenience Fees (broker kept - operating expense)</td><td style={{...TDr,color:'#e65100',fontSize:11}}>{fmt(d.totalAchFees)}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        {/* CARRIER ADVANCES — all-time detail */}
        {d.carrierAdvRows.length > 0 && (
          <div style={{ marginBottom:24 }}>
            <div style={{ fontSize:12, fontWeight:900, color:'#1a2a3a', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:6, paddingLeft:4 }}>CARRIER ADVANCES — ALL TIME</div>
            <div style={{ background:'#fff8e1', border:'1px solid #ffe082', borderRadius:8, padding:'10px 14px', marginBottom:8, fontSize:11, color:'#7a5c00' }}>
              Direct carrier-to-driver loans (breakdown, repair, fuel, general). Unrepaid advances reduce the balance owed above. Repaid advances are shown for the record but no longer reduce the balance.
            </div>
            <div style={{ borderRadius:8, border:'1px solid #e0e0e0', overflow:'hidden' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead><tr>
                  <th style={TH}>Date</th>
                  <th style={TH}>Reason</th>
                  <th style={TH}>Notes</th>
                  <th style={{...TH,textAlign:'right'}}>Amount</th>
                  <th style={{...TH,textAlign:'right'}}>Status</th>
                </tr></thead>
                <tbody>
                  {d.carrierAdvRows.map((a,i) => (
                    <tr key={i} style={{ background:i%2===0?'#fff':'#fafafa' }}>
                      <td style={TD}>{a.advance_date||'-'}</td>
                      <td style={TD}><span style={{ fontSize:10, fontWeight:700, padding:'2px 6px', borderRadius:4, background:'#fff3e0', color:'#e65100', textTransform:'uppercase' }}>{a.reason||'general'}</span></td>
                      <td style={{...TD,color:'#666',fontSize:11}}>{a.notes||'-'}</td>
                      <td style={{...TDr,color:a.repaid?'#aaa':'#e65100'}}>{fmt(a.amount)}</td>
                      <td style={{...TDr,color:a.repaid?'#2e7d32':'#c62828',fontSize:11}}>{a.repaid?'REPAID':'OPEN'}</td>
                    </tr>
                  ))}
                  <tr>
                    <td style={TF} colSpan={3}>UNREPAID TOTAL (reduces balance)</td>
                    <td style={{...TFr,color:'#e65100'}} colSpan={2}>{fmt(d.allCarrierAdvance)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
        {/* SOURCE OF FUNDS — FIFO */}
        {(d.fifoRows.length > 0 || Object.keys(d.fifoUnpaid).length > 0) && (
          <div style={{ marginBottom:24 }}>
            <div style={{ fontSize:12, fontWeight:900, color:'#1a2a3a', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:6, paddingLeft:4 }}>SOURCE OF FUNDS — FIFO</div>
            <div style={{ background:'#fff8e1', border:'1px solid #ffe082', borderRadius:8, padding:'10px 14px', marginBottom:8, fontSize:11, color:'#7a5c00' }}>
              Every payout is traced to the oldest earnings still on the books at that time — first in, first out, the way an auditor reads a ledger. The balance owed is whatever earnings remain unclaimed at the bottom.
            </div>
            {d.fifoRows.length > 0 && (
              <div style={{ borderRadius:8, border:'1px solid #e0e0e0', overflow:'hidden', marginBottom:8 }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                  <thead><tr>
                    <th style={TH}>Paid Out</th>
                    <th style={{...TH,textAlign:'right'}}>Amount</th>
                    <th style={{...TH,textAlign:'right'}}>Funded By</th>
                  </tr></thead>
                  <tbody>
                    {d.fifoRows.map((r,i) => {
                      const tcol = r.type==='FUEL' ? '#c62828' : r.type==='ACH' ? '#2e7d32' : r.type==='ETTR' ? '#7b1fa2' : r.type==='PAY' ? '#00c853' : '#f57c00'
                      return (
                        <tr key={i} style={{ background:i%2===0?'#fff':'#fafafa' }}>
                          <td style={TD}>
                            <span style={{ fontSize:9, fontWeight:700, padding:'1px 5px', borderRadius:3, background:tcol+'18', color:tcol, marginRight:6 }}>{r.type}</span>
                            <span style={{ fontSize:11 }}>{r.label}</span>
                            <div style={{ fontSize:10, color:'#888' }}>{r.date.toLocaleDateString('en-US',{ month:'short', day:'numeric', year:'numeric' })}</div>
                          </td>
                          <td style={{...TDr,color:tcol}}>{fmt(r.amount)}</td>
                          <td style={{...TDr,fontSize:10,fontWeight:600,color:'#555',maxWidth:160,whiteSpace:'normal'}}>{fmtSources(r.sources)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ borderRadius:8, border:'1px solid #e0e0e0', overflow:'hidden' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead><tr>
                  <th style={TH}>Balance Owed Is Made Of</th>
                  <th style={{...TH,textAlign:'right'}}>Unpaid Earnings</th>
                </tr></thead>
                <tbody>
                  {Object.keys(d.fifoUnpaid).length === 0 && (
                    <tr><td style={TD} colSpan={2}>All earnings to date have been paid out.</td></tr>
                  )}
                  {Object.keys(d.fifoUnpaid).map((m,i) => (
                    <tr key={m} style={{ background:i%2===0?'#fff':'#fafafa' }}>
                      <td style={TD}>{m} deliveries</td>
                      <td style={{...TDr,color:'#1a2a3a'}}>{fmt(d.fifoUnpaid[m])}</td>
                    </tr>
                  ))}
                  <tr style={{background:'#1a2a3a'}}>
                    <td style={{ padding:'10px 12px', fontSize:12, fontWeight:900, color:'#fff', fontFamily:'var(--font-head)', letterSpacing:'0.04em' }}>TOTAL UNPAID EARNINGS</td>
                    <td style={{ padding:'10px 12px', textAlign:'right', fontSize:14, fontWeight:900, color:'#ffd54f', fontFamily:'var(--font-head)' }}>{fmt(Object.keys(d.fifoUnpaid).reduce((s,m) => s + d.fifoUnpaid[m], 0))}</td>
                  </tr>
                  {d.fifoUnfunded > 0.005 && (
                    <tr style={{background:'#ffebee'}}>
                      <td style={{...TD,color:'#c62828',fontSize:11}}>Payouts ahead of earnings (drawn before the earnings existed)</td>
                      <td style={{...TDr,color:'#c62828',fontSize:11}}>{fmt(d.fifoUnfunded)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {d.pocketFuelTotal > 0 && (
          <div style={{ background:'#e3f2fd', borderRadius:8, padding:'12px 14px', marginBottom:16, border:'1px solid #bbdefb' }}>
            <div style={{ fontSize:11, color:'#1565c0', fontFamily:'var(--font-head)', fontWeight:700, marginBottom:4 }}>TAX NOTE — PERIOD</div>
            <div style={{ fontSize:12, color:'#1a3a6a' }}>Out of Pocket Fuel this period: <strong>{fmt(d.pocketFuelTotal)}</strong> — paid by driver, deductible business expense.</div>
          </div>
        )}
        <div style={{ textAlign:'center', fontSize:10, color:'#aaa', paddingBottom:32 }}>Generated by Load Ledger — dbappsystems.com</div>
      </div>
    </div>
  )
}

// -- MAIN EXPORTED COMPONENT -------------------------------------------
export default function SettlementReport({ driverName, loads, showToast, ownerCutPct = 10 }) {
  const isBookkeeper = driverName === null

  const [loaded,          setLoaded]          = useState(false)
  const [loading,         setLoading]         = useState(false)
  const [fuelEntries,     setFuelEntries]     = useState([])
  // Raw escrow records — filtered all-time for running balance, by period for display row
  const [escrowPayments,  setEscrowPayments]  = useState([])
  // Carrier advances — carrier->driver direct loans; unrepaid reduce the balance.
  const [carrierAdvances, setCarrierAdvances] = useState([])
  const [period,          setPeriod]          = useState('monthly')
  const [periodOffset,    setPeriodOffset]    = useState(0)
  const [showStatement,   setShowStatement]   = useState(null)
  const [showPaystub,     setShowPaystub]     = useState(null)
  // Period Activity drill-down: {driver, key} identifies which label was tapped
  const [drilldown,       setDrilldown]       = useState(null)

  // Fuel entry form state
  const [showFuelDrawer,  setShowFuelDrawer]  = useState(false)
  const [fuelDriver,      setFuelDriver]      = useState(isBookkeeper ? 'TIM' : driverName || 'TIM')
  const [fuelDate,        setFuelDate]        = useState(new Date().toISOString().split('T')[0])
  const [fuelAmount,      setFuelAmount]      = useState('')
  const [fuelType,        setFuelType]        = useState('fleet')
  const [fuelNotes,       setFuelNotes]       = useState('')
  const [fuelOdo,         setFuelOdo]         = useState('')
  const [fuelScanning,    setFuelScanning]    = useState(false)
  const [fuelSaving,      setFuelSaving]      = useState(false)
  const [fuelReceiptB64,  setFuelReceiptB64]  = useState(null)
  const [fuelReceiptType, setFuelReceiptType] = useState(null)
  const [fuelPreview,     setFuelPreview]     = useState(null)
  const fuelFileRef = useRef()

  // Fuel entry EDIT state
  const [editFuelId,      setEditFuelId]      = useState(null)
  const [editFuelDate,    setEditFuelDate]    = useState('')
  const [editFuelAmount,  setEditFuelAmount]  = useState('')
  const [editFuelType,    setEditFuelType]    = useState('fleet')
  const [editFuelNotes,   setEditFuelNotes]   = useState('')
  const [editFuelOdo,     setEditFuelOdo]     = useState('')
  const [editFuelSaving,  setEditFuelSaving]  = useState(false)

  // Carrier advance entry form state
  const [showAdvDrawer,   setShowAdvDrawer]   = useState(false)
  const [advDriver,       setAdvDriver]       = useState(isBookkeeper ? 'TIM' : driverName || 'TIM')
  const [advDate,         setAdvDate]         = useState(new Date().toISOString().split('T')[0])
  const [advAmount,       setAdvAmount]       = useState('')
  const [advReason,       setAdvReason]       = useState('repair')
  const [advNotes,        setAdvNotes]        = useState('')
  const [advSaving,       setAdvSaving]       = useState(false)

  // Driver payment (cash/check) form state — pay-side only. A payment reconciles
  // the driver's OLDEST unpaid billed load first (FIFO), same as a general advance.
  const [settlementPayments, setSettlementPayments] = useState([])
  const [showPayDrawer,   setShowPayDrawer]   = useState(false)
  const [payDriver,       setPayDriver]       = useState(isBookkeeper ? 'TIM' : driverName || 'TIM')
  const [payDate,         setPayDate]         = useState(new Date().toISOString().split('T')[0])
  const [payAmount,       setPayAmount]       = useState('')
  const [payMethod,       setPayMethod]       = useState('check')
  const [payReference,    setPayReference]    = useState('')
  const [payNotes,        setPayNotes]        = useState('')
  const [paySaving,       setPaySaving]       = useState(false)

  // WHITE-LABEL: the tenant's own drivers + colors (see render section). Hook
  // lives here with the other hooks to satisfy React's rules-of-hooks ordering.
  const { names: driverNames, colorFor } = useDrivers()

  async function loadData() {
    if (loaded || loading) return
    setLoading(true)
    try {
      // WHITE-LABEL: fuel + carrier advances are fetched for every tenant driver
      // (driverNames from useDrivers, which falls back to TIM/BRUCE). Escrow stays
      // TIM-specific — it's the Edgerton ETTR financing tracker, out of scope here.
      const fuelTasks = driverNames.map(dn => apiClient('/api/fuel/' + dn).catch(()=>[]))
      const advTasks  = driverNames.map(dn => apiClient('/api/carrier-advances/' + dn).catch(()=>[]))
      const payTasks  = driverNames.map(dn => apiClient('/api/settlement-payments/' + dn).catch(()=>[]))
      // Escrow is TIM-specific (the Edgerton ETTR financing tracker) but it must
      // load for EVERY viewer of TIM — TIM himself, the bookkeeper, AND an owner
      // (Bruce) viewing TIM. The old `driverName !== 'BRUCE'` exclusion meant that
      // when Bruce loaded the report while viewing himself first, escrow never
      // fetched, and the load guard then kept it empty after he toggled to TIM —
      // so Bruce saw TIM's balance WITHOUT the escrow offset TIM already applied.
      // Always fetch it; it's harmless (empty) for any non-TIM driver.
      const escrowTask = apiClient('/api/escrow-payments/TIM').catch(()=>[])
      const [fuelResults, advResults, payResults, escrowResult] = await Promise.all([
        Promise.all(fuelTasks),
        Promise.all(advTasks),
        Promise.all(payTasks),
        escrowTask,
      ])
      const fuelFlat = fuelResults.flatMap(r => Array.isArray(r) ? r : [])
      const advFlat  = advResults.flatMap(r => Array.isArray(r) ? r : [])
      setFuelEntries(fuelFlat)
      setCarrierAdvances(advFlat)
      setSettlementPayments(payResults.flatMap(r => Array.isArray(r) ? r : []))
      if (escrowResult) {
        setEscrowPayments(Array.isArray(escrowResult) ? escrowResult : [])
      }
      setLoaded(true)
    } catch (err) {
      showToast('Could not load settlement data')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  async function refreshFuel() {
    try {
      const results = await Promise.all(
        driverNames.map(dn => apiClient('/api/fuel/' + dn).catch(()=>[]))
      )
      setFuelEntries(results.flatMap(r => Array.isArray(r) ? r : []))
    } catch {}
  }

  async function refreshAdvances() {
    try {
      const results = await Promise.all(
        driverNames.map(dn => apiClient('/api/carrier-advances/' + dn).catch(()=>[]))
      )
      setCarrierAdvances(results.flatMap(r => Array.isArray(r) ? r : []))
    } catch {}
  }

  async function refreshPayments() {
    try {
      const results = await Promise.all(
        driverNames.map(dn => apiClient('/api/settlement-payments/' + dn).catch(()=>[]))
      )
      setSettlementPayments(results.flatMap(r => Array.isArray(r) ? r : []))
    } catch {}
  }

  // -- ESCROW HELPERS ------------------------------------------------
  // Period display: only show escrow that was recorded in the selected period
  function escrowForPeriod(dn) {
    if (dn !== 'TIM') return 0
    return escrowPayments
      .filter(p => inPeriodByDate(p.funded_at, period, periodOffset))
      .reduce((s, p) => s + (parseFloat(p.amount) || 0), 0)
  }
  // Running balance: ALL escrow ever applied — used for the bottom-line balance
  function escrowAllTime(dn) {
    if (dn !== 'TIM') return 0
    return escrowPayments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0)
  }

  // -- CARRIER ADVANCE HELPERS ---------------------------------------
  // All advances for one driver (feeds running balance + detail table).
  function advancesForDriver(dn) {
    return carrierAdvances.filter(a => (a.driver || '').toUpperCase() === dn.toUpperCase())
  }

  // All-time cash/check paid to one driver, summed to a NUMBER (settlement_payments).
  // Returns a number so computeRunningBalance's parseFloat subtracts it correctly.
  function paymentsForDriver(dn) {
    return settlementPayments
      .filter(p => (p.driver || '').toUpperCase() === dn.toUpperCase())
      .reduce((s,p) => s + (parseFloat(p.amount) || 0), 0)
  }

  // -- PERIOD FUEL HELPERS -------------------------------------------
  function fuelForPeriod(dn, fuelTypeFilter) {
    return fuelEntries
      .filter(f => f.driver === dn.toUpperCase() && f.fuel_type === fuelTypeFilter && inPeriodByDate(f.entry_date, period, periodOffset))
      .reduce((s,f) => s + (parseFloat(f.amount)||0), 0)
  }

  function fuelEntriesForPeriod(dn) {
    return fuelEntries.filter(f => f.driver === dn.toUpperCase() && inPeriodByDate(f.entry_date, period, periodOffset))
  }

  // -- RUNNING BALANCE — all-time ------------------------------------
  // This is the true "what does the company owe this driver right now" number.
  // It uses every load, every fuel entry, every ACH payment, every escrow
  // ever recorded. Not period-filtered. Never resets.
  function runningBalance(dn) {
    // ONE formula — src/settlementMath.js. Same shape, same numbers.
    return computeRunningBalance({
      loads, fuelEntries,
      escrowTotal: escrowAllTime(dn),
      driver: dn,
      ownerCutPct,
      carrierAdvances: advancesForDriver(dn),
      settlementPaymentsTotal: paymentsForDriver(dn),
    })
  }

  function buildSettlementData(dn) {
    const dLoads      = loads.filter(l => l.driver === dn)
    const inRange     = dLoads.filter(l => inPeriod(l, period, periodOffset))
    const fuelInRange = fuelEntries.filter(f => f.driver === dn && inPeriodByDate(f.entry_date, period, periodOffset))
    const fleetFuelTotal  = fuelInRange.filter(f => f.fuel_type === 'fleet').reduce((s,f) => s+(parseFloat(f.amount)||0), 0)
    const pocketFuelTotal = fuelInRange.filter(f => f.fuel_type === 'pocket').reduce((s,f) => s+(parseFloat(f.amount)||0), 0)
    let totalRateCon = 0, totalGross90 = 0, totalDetention = 0, totalEarned = 0, totalAdvKept = 0, totalReimb = 0
    const earningsRows = inRange.map(l => {
      const base    = parseFloat(l.base_pay) || 0
      const det     = parseFloat(l.detention) || 0
      const ownerCut = normalizeOwnerCut(ownerCutPct)
      const gross90 = base * (1 - ownerCut)  // driver's take after the company split
      const earned  = gross90 + det
      totalRateCon += base; totalGross90 += gross90; totalDetention += det; totalEarned += earned
      return { loadNum: l.load_number || '-', base, gross90, det, earned, isAch: !!l.ach_payment, achReceived: parseFloat(l.ach_received)||0 }
    })
    const advRows = inRange.filter(l => {
      const { comdataTotal, lumperTotal, incTotal } = getLoadTotals(l)
      return comdataTotal > 0 || lumperTotal > 0 || incTotal > 0
    }).map(l => {
      const { comdataTotal, lumperTotal, incTotal } = getLoadTotals(l)
      const expenses = lumperTotal + incTotal
      const advKept  = Math.max(0, comdataTotal - expenses)
      const reimb    = Math.max(0, expenses - comdataTotal)
      totalAdvKept += advKept; totalReimb += reimb
      return { loadNum: l.load_number || '-', comdata: comdataTotal, expenses, advKept, reimb }
    })
    const achLoads          = inRange.filter(l => l.ach_payment)
    const totalAchDisbursed = achLoads.reduce((s,l) => s + (parseFloat(l.ach_received)||0), 0)
    const totalAchFees      = achLoads.reduce((s,l) => s + Math.max(0, (parseFloat(l.netPay||l.net_pay)||0) - (parseFloat(l.ach_received)||0)), 0)
    // Running balance for bottom-line "owed" number
    const rb = runningBalance(dn)
    // FIFO source-of-funds — display-only audit trail (all-time)
    const fifo = buildFifoLedger(
      dLoads,
      fuelEntries.filter(f => f.driver === dn.toUpperCase()),
      dn === 'TIM' ? escrowPayments : [],
      ownerCutPct,
      settlementPayments.filter(p => (p.driver || '').toUpperCase() === dn.toUpperCase()),
    )
    const fifoRows = mergeFuelRowsByMonth(fifo.debitRows)
    // Carrier advances — all-time detail rows (newest first), for the statement table
    const carrierAdvRows = advancesForDriver(dn)
      .slice()
      .sort((a,b) => String(b.advance_date||'').localeCompare(String(a.advance_date||'')))
    return {
      driverName: dn,
      periodLabel: getPeriodLabel(period, periodOffset),
      generated: new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' }),
      earningsRows, totalRateCon, totalGross90, totalDetention, totalEarned,
      advRows, totalAdvKept, totalReimb,
      fuelInRange, fleetFuelTotal, pocketFuelTotal,
      achLoads, totalAchDisbursed, totalAchFees,
      carrierAdvRows,
      fifoRows, fifoUnpaid: fifo.unpaid, fifoUnfunded: fifo.unfunded,
      // Running balance fields for the summary table
      ...rb,
    }
  }

  // driverStats: period display rows + running balance for "still owed"
  function driverStats(dn) {
    const dLoads = loads.filter(l => l.driver === dn)
    const inRange = dLoads.filter(l => inPeriod(l, period, periodOffset))

    // Period display values (shown as activity rows in the card)
    const detentionTotal = inRange.reduce((s,l) => s + (parseFloat(l.detention)||0), 0)
    const advKeptPeriod  = inRange.reduce((s,l) => s + advanceKept(l), 0)
    const reimbPeriod    = inRange.reduce((s,l) => s + reimbursementOwed(l), 0)
    const gPayPeriod     = inRange.reduce((s,l) => s + calcPay(l, ownerCutPct).driverNet, 0)
    const fleetFuelPrd   = fuelForPeriod(dn, 'fleet')
    const pocketFuelPrd  = fuelForPeriod(dn, 'pocket')
    const achDisbPeriod  = inRange.filter(l => l.ach_payment).reduce((s,l) => s+(parseFloat(l.ach_received)||0), 0)
    const achFeesPeriod  = inRange.filter(l => l.ach_payment).reduce((s,l) => s+Math.max(0,(parseFloat(l.netPay||l.net_pay)||0)-(parseFloat(l.ach_received)||0)), 0)
    // Escrow: show as a line item only when it was applied in the selected period
    const escrowPeriod   = escrowForPeriod(dn)

    // Running balance — the only correct "still owed" answer
    const rb = runningBalance(dn)

    return {
      count: inRange.length,
      rateCon: inRange.reduce((s,l) => s+(parseFloat(l.base_pay)||0), 0),
      grossPay: gPayPeriod,
      detentionTotal,
      advanceKept: advKeptPeriod,
      reimbOwed: reimbPeriod,
      fleetFuel: fleetFuelPrd,
      pocketFuel: pocketFuelPrd,
      achDisbursed: achDisbPeriod,
      achFees: achFeesPeriod,
      escrowApplied: escrowPeriod, // display row: only when in this period
      carrierAdvanceOwed: rb.allCarrierAdvance, // all-time unrepaid (reduces balance)
      driverPaidAllTime: rb.allSettlementPayments, // all-time cash/check paid (reduces balance)
      stillOwed: rb.stillOwed,     // running balance — all-time correct answer
    }
  }

  // -- FUEL ENTRY HANDLERS ---------------------------------------
  async function handleFuelFile(e) {
    const file = e.target.files[0]
    if (!file) return
    setFuelScanning(true)
    showToast('Scanning fuel receipt...')
    try {
      const scanned   = await processFile(file)
      const base64    = await toBase64(file)
      const mediaType = isPDF(file) ? 'application/pdf' : (file.type || 'image/jpeg')
      const json2 = await apiClient('/api/ocr', {
        method: 'POST',
        json: { base64, mediaType, mode: 'fuel' },
      })
      if (json2.error) throw new Error(json2.detail || json2.error)
      let raw = json2.result || ''
      raw = raw.replace(/```json/gi,'').replace(/```/gi,'').trim()
      const start = raw.indexOf('{'), end = raw.lastIndexOf('}')
      if (start === -1 || end === -1) throw new Error('No data found')
      const parsed = JSON.parse(raw.substring(start, end + 1))
      const amount = parsed.amount || '0.00'
      setFuelAmount(amount)
      setFuelReceiptB64(scanned.base64)
      setFuelReceiptType('image/jpeg')
      setFuelPreview(scanned.dataUrl)
      showToast('Fuel receipt scanned! $' + amount)
    } catch {
      showToast('Scan failed — enter amount manually')
    } finally {
      setFuelScanning(false)
      e.target.value = ''
    }
  }

  async function saveFuelEntry() {
    const amt = parseFloat(fuelAmount)
    if (!amt || amt <= 0) { showToast('Enter a valid amount'); return }
    setFuelSaving(true)
    try {
      let data
      try {
        data = await apiClient('/api/fuel', {
          method: 'POST',
          json: { driver: fuelDriver, entry_date: fuelDate, amount: amt, fuel_type: fuelType, notes: fuelNotes, odometer: fuelOdo ? parseInt(fuelOdo, 10) : null },
        })
      } catch (e) { showToast('Save failed: ' + e.message); return }
      if (fuelReceiptB64 && data.id) {
        try {
          await apiClient('/api/fuel-receipt/' + data.id, {
            method: 'POST',
            json: { base64: fuelReceiptB64, mediaType: fuelReceiptType || 'image/jpeg' },
          })
        } catch {}
      }
      showToast('Fuel entry saved!')
      setFuelAmount(''); setFuelNotes(''); setFuelOdo(''); setFuelReceiptB64(null)
      setFuelReceiptType(null); setFuelPreview(null)
      setShowFuelDrawer(false)
      await refreshFuel()
    } catch (err) {
      showToast('Save failed: ' + err.message)
    } finally {
      setFuelSaving(false)
    }
  }

  async function deleteFuelEntry(id) {
    try {
      try {
        await apiClient('/api/fuel/' + id, { method: 'DELETE' })
      } catch { showToast('Delete failed'); return }
      showToast('Fuel entry deleted')
      await refreshFuel()
    } catch { showToast('Delete failed') }
  }

  function startEditFuel(f) {
    setEditFuelId(f.id)
    setEditFuelDate(f.entry_date || '')
    setEditFuelAmount(f.amount !== undefined && f.amount !== null ? String(f.amount) : '')
    setEditFuelType(f.fuel_type === 'pocket' ? 'pocket' : 'fleet')
    setEditFuelNotes(f.notes || '')
    setEditFuelOdo(f.odometer && Number(f.odometer) > 0 ? String(Math.round(f.odometer)) : '')
  }

  function cancelEditFuel() { setEditFuelId(null) }

  async function saveEditFuel() {
    const amt = parseFloat(editFuelAmount)
    if (!amt || amt <= 0) { showToast('Enter a valid amount'); return }
    setEditFuelSaving(true)
    try {
      try {
        await apiClient('/api/fuel/' + editFuelId, {
          method: 'PATCH',
          json: { entry_date: editFuelDate, amount: amt, fuel_type: editFuelType, notes: editFuelNotes, odometer: editFuelOdo ? parseInt(editFuelOdo, 10) : null },
        })
      } catch (e) { showToast('Update failed: ' + e.message); return }
      showToast('Fuel entry updated')
      setEditFuelId(null)
      await refreshFuel()
    } catch (err) {
      showToast('Update failed: ' + err.message)
    } finally {
      setEditFuelSaving(false)
    }
  }

  // -- CARRIER ADVANCE HANDLERS ----------------------------------
  async function saveCarrierAdvance() {
    const amt = parseFloat(advAmount)
    if (!amt || amt <= 0) { showToast('Enter a valid amount'); return }
    setAdvSaving(true)
    try {
      try {
        await apiClient('/api/carrier-advance', {
          method: 'POST',
          json: { driver: advDriver, advance_date: advDate, amount: amt, reason: advReason, notes: advNotes },
        })
      } catch (e) { showToast('Save failed: ' + e.message); return }
      showToast('Carrier advance saved!')
      setAdvAmount(''); setAdvNotes(''); setAdvReason('repair')
      setShowAdvDrawer(false)
      await refreshAdvances()
    } catch (err) {
      showToast('Save failed: ' + err.message)
    } finally {
      setAdvSaving(false)
    }
  }

  async function toggleAdvanceRepaid(a) {
    try {
      try {
        await apiClient('/api/carrier-advance/' + a.id, {
          method: 'PATCH',
          json: { repaid: a.repaid ? 0 : 1 },
        })
      } catch (e) { showToast('Update failed: ' + e.message); return }
      showToast(a.repaid ? 'Advance reopened' : 'Advance marked repaid')
      await refreshAdvances()
    } catch (err) {
      showToast('Update failed: ' + err.message)
    }
  }

  async function deleteCarrierAdvance(id) {
    try {
      try {
        await apiClient('/api/carrier-advance/' + id, { method: 'DELETE' })
      } catch { showToast('Delete failed'); return }
      showToast('Carrier advance deleted')
      await refreshAdvances()
    } catch { showToast('Delete failed') }
  }

  // -- DRIVER PAYMENT HANDLERS (pay-side: cash/check disbursements) --------
  async function saveDriverPayment() {
    const amt = parseFloat(payAmount)
    if (!amt || amt <= 0) { showToast('Enter a valid amount'); return }
    setPaySaving(true)
    try {
      try {
        await apiClient('/api/settlement-payment', {
          method: 'POST',
          json: { driver: payDriver, paid_at: payDate, amount: amt, method: payMethod, reference: payReference, notes: payNotes },
        })
      } catch (e) { showToast('Save failed: ' + e.message); return }
      showToast('Payment recorded!')
      setPayAmount(''); setPayReference(''); setPayNotes('')
      setShowPayDrawer(false)
      await refreshPayments()
    } catch (err) {
      showToast('Save failed: ' + err.message)
    } finally {
      setPaySaving(false)
    }
  }

  async function deleteDriverPayment(id) {
    try {
      try {
        await apiClient('/api/settlement-payment/' + id, { method: 'DELETE' })
      } catch { showToast('Delete failed'); return }
      showToast('Payment deleted')
      await refreshPayments()
    } catch { showToast('Delete failed') }
  }

  function changePeriod(p) { setPeriod(p); setPeriodOffset(0) }

  // -- PERIOD ACTIVITY DRILL-DOWN --------------------------------
  // Display-only. Reads the same period-filtered records the card uses.
  function drillCtx() {
    return {
      loads, fuelEntries, escrowPayments, ownerCutPct,
      period, periodOffset, inPeriod, inPeriodByDate, advancesForDriver,
      settlementPayments,
    }
  }
  function openDrill(dn, key) { setDrilldown({ driver: dn, key }) }
  const drillMeta = drilldown ? buildDrilldown(drillCtx(), drilldown.driver, drilldown.key) : null

  // -- RENDER ----------------------------------------------------
  const navBtn = {
    padding:'6px 18px', borderRadius:8, border:'1px solid var(--border)',
    background:'var(--navy3)', color:'var(--white)', fontSize:22,
    fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer', lineHeight:1,
  }
  const inputStyle = {
    width:'100%', background:'var(--navy3)', border:'1px solid var(--border)',
    color:'var(--white)', borderRadius:8, padding:'8px 10px',
    fontSize:14, fontFamily:'var(--font-body)', boxSizing:'border-box',
  }

  // WHITE-LABEL: driver display list from the tenant's drivers (was hardcoded
  // ['BRUCE','TIM']). Bookkeeper sees every tenant driver; a driver sees self.
  const driversToShow = isBookkeeper ? driverNames : [driverName]
  const REASONS = ['repair','general','fuel','other']

  return (
    <div>
      {/* Full statement overlay */}
      {showStatement && loaded && (
        <StatementOverlay
          data={buildSettlementData(showStatement)}
          driverName={showStatement}
          headerColor={colorFor(showStatement)}
          onClose={() => setShowStatement(null)}
        />
      )}

      {/* Weekly driver paystub overlay (read-only, Monday-Monday) */}
      {showPaystub && (
        <DriverPaystub
          driverName={showPaystub}
          loads={loads}
          ownerCutPct={ownerCutPct}
          color={colorFor(showPaystub)}
          onClose={() => setShowPaystub(null)}
        />
      )}

      {/* Period Activity drill-down — black & white source ledger */}
      {drilldown && drillMeta && (
        <DrilldownOverlay
          meta={drillMeta}
          driverName={drilldown.driver}
          periodLabel={getPeriodLabel(period, periodOffset)}
          onClose={() => setDrilldown(null)}
        />
      )}

      <input ref={fuelFileRef} type="file" accept="image/*,application/pdf" style={{display:'none'}} onChange={handleFuelFile} />

      {/* Load data trigger */}
      {!loaded && (
        <div style={{ textAlign:'center', padding:'20px 0' }}>
          <button
            onClick={loadData}
            disabled={loading}
            style={{ padding:'14px 32px', borderRadius:10, border:'none', background: loading ? '#555' : 'var(--amber)', color: loading ? '#aaa' : '#0A1628', fontFamily:'var(--font-head)', fontWeight:900, fontSize:14, cursor:'pointer', letterSpacing:'0.06em' }}
          >
            {loading ? 'LOADING...' : '\uD83D\uDCB5 LOAD SETTLEMENT DATA'}
          </button>
        </div>
      )}

      {/* Main content — shown after load */}
      {loaded && (
        <div>
          {/* Period type selector */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:6, marginBottom:10 }}>
            {['daily','weekly','monthly','yearly'].map(p => (
              <button key={p} onClick={() => changePeriod(p)} style={{
                padding:'9px 4px', borderRadius:8, border:'none',
                fontFamily:'var(--font-head)', fontWeight:700, fontSize:11,
                letterSpacing:'0.04em', cursor:'pointer',
                background: period === p ? 'var(--white)' : 'var(--navy3)',
                color:       period === p ? 'var(--navy)'  : 'var(--grey)',
              }}>{p.toUpperCase()}</button>
            ))}
          </div>

          {/* Period navigator */}
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
            <button style={navBtn} onClick={() => setPeriodOffset(o => o - 1)}>&#8249;</button>
            <div style={{ textAlign:'center', flex:1, padding:'0 8px' }}>
              <div style={{ fontFamily:'var(--font-head)', fontSize:13, color:'var(--amber)', letterSpacing:'0.08em' }}>
                {getPeriodLabel(period, periodOffset)}
              </div>
              {periodOffset === 0 && <div style={{ fontSize:10, color:'var(--grey)', marginTop:2 }}>CURRENT</div>}
            </div>
            <button style={{ ...navBtn, opacity: periodOffset >= 0 ? 0.3 : 1 }} disabled={periodOffset >= 0} onClick={() => setPeriodOffset(o => o + 1)}>&#8250;</button>
          </div>

          {/* Chronology note */}
          <div style={{ fontSize:9, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.08em', textAlign:'center', marginBottom:12, textTransform:'uppercase' }}>
            Loads shown by delivery date — fuel &amp; repair payments by entry date
          </div>

          {/* Driver settlement cards */}
          {driversToShow.map(dn => {
            const s     = driverStats(dn)
            const color = colorFor(dn)
            const fuelList = fuelEntriesForPeriod(dn)
            const advList  = advancesForDriver(dn)
            return (
              <div key={dn} className="card" style={{ borderLeft:'3px solid ' + color, marginBottom:12 }}>
                <div style={{ fontFamily:'var(--font-head)', fontWeight:900, fontSize:15, color, marginBottom:10 }}>{dn}</div>

                {/* PERIOD ACTIVITY LABEL */}
                <div style={{ fontSize:9, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.1em', marginBottom:8, textTransform:'uppercase' }}>
                  Period Activity — {getPeriodLabel(period, periodOffset)}
                </div>

                <div className="amount-row" style={{cursor:'pointer'}} onClick={() => openDrill(dn,'loads')}><span className="label">Loads &#8250;</span><span className="value">{s.count}</span></div>
                <div className="amount-row" style={{cursor:'pointer'}} onClick={() => openDrill(dn,'ratecon')}><span className="label">Rate Con Total &#8250;</span><span className="value">{fmt(s.rateCon)}</span></div>
                <div className="amount-row" style={{cursor:'pointer'}} onClick={() => openDrill(dn,'driverpay')}><span className="label">Driver Pay &#8250;</span><span className="value" style={{color:'var(--amber)'}}>{fmt(s.grossPay - s.detentionTotal)}</span></div>
                {s.detentionTotal > 0 && <div className="amount-row" style={{cursor:'pointer'}} onClick={() => openDrill(dn,'detention')}><span className="label" style={{color:'var(--green)'}}>+ Detention &#8250;</span><span className="value" style={{color:'var(--green)'}}>+{fmt(s.detentionTotal)}</span></div>}
                {s.advanceKept > 0 && <div className="amount-row" style={{cursor:'pointer'}} onClick={() => openDrill(dn,'advance')}><span className="label">Broker Advance (Comdata) &#8250;</span><span className="value" style={{color:'var(--green)'}}>{fmt(s.advanceKept)}</span></div>}
                {s.reimbOwed > 0 && <div className="amount-row" style={{cursor:'pointer'}} onClick={() => openDrill(dn,'reimb')}><span className="label" style={{color:'var(--amber)'}}>+ Lumper Reimb &#8250;</span><span className="value" style={{color:'var(--amber)'}}>+{fmt(s.reimbOwed)}</span></div>}
                {s.fleetFuel > 0 && <div className="amount-row" style={{cursor:'pointer'}} onClick={() => openDrill(dn,'fleetfuel')}><span className="label">Fleet Fuel &#8250;</span><span className="value" style={{color:'var(--red)'}}>{fmt(s.fleetFuel)}</span></div>}
                {s.achDisbursed > 0 && <div className="amount-row" style={{cursor:'pointer'}} onClick={() => openDrill(dn,'ach')}><span className="label" style={{color:'#2e7d32'}}>ACH Paid Out &#8250;</span><span className="value" style={{color:'#2e7d32'}}>-{fmt(s.achDisbursed)}</span></div>}
                {s.driverPaidAllTime > 0 && <div className="amount-row" style={{cursor:'pointer'}} onClick={() => openDrill(dn,'driverpaid')}><span className="label" style={{color:'#00c853'}}>Driver Paid (cash/check) &#8250;</span><span className="value" style={{color:'#00c853'}}>-{fmt(s.driverPaidAllTime)}</span></div>}
                {/* Carrier advance: all-time unrepaid total that reduces the balance */}
                {s.carrierAdvanceOwed > 0 && (
                  <div className="amount-row" style={{cursor:'pointer'}} onClick={() => openDrill(dn,'carrieradv')}>
                    <span className="label" style={{color:'#e65100'}}>Carrier Advance (unrepaid) &#8250;</span>
                    <span className="value" style={{color:'#e65100'}}>-{fmt(s.carrierAdvanceOwed)}</span>
                  </div>
                )}
                {/* Escrow: display row only when it was recorded in this period */}
                {s.escrowApplied > 0 && (
                  <div className="amount-row" style={{cursor:'pointer'}} onClick={() => openDrill(dn,'escrow')}>
                    <span className="label" style={{color:'#ce93d8'}}>ETTR Repair Payment (this period) &#8250;</span>
                    <span className="value" style={{color:'#ce93d8'}}>-{fmt(s.escrowApplied)}</span>
                  </div>
                )}

                {/* RUNNING BALANCE — separated clearly */}
                <div style={{ borderTop:'2px solid var(--border)', marginTop:10, paddingTop:10 }}>
                  <div style={{ fontSize:9, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.1em', marginBottom:6, textTransform:'uppercase' }}>
                    Running Balance — All Time
                  </div>
                  <div className="amount-row">
                    <span className="label" style={{fontWeight:900,color:'var(--white)',fontSize:14}}>Balance Owed to {dn}</span>
                    <span className="value" style={{color:'var(--amber)',fontSize:18,fontWeight:900}}>{fmt(s.stillOwed)}</span>
                  </div>
                </div>

                {s.achFees > 0 && <div className="amount-row" style={{marginTop:4}}><span className="label" style={{color:'#e65100',fontSize:11}}>ACH Broker Fees</span><span className="value" style={{color:'#e65100',fontSize:11}}>{fmt(s.achFees)}</span></div>}

                {/* Fuel entries for this driver in period */}
                {fuelList.length > 0 && (
                  <div style={{marginTop:8,paddingTop:8,borderTop:'1px solid var(--border)'}}>
                    <div style={{ fontSize:10, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.06em', marginBottom:6 }}>FUEL ENTRIES</div>
                    {fuelList.map(f => (
                      editFuelId === f.id ? (
                        <div key={f.id} style={{ background:'var(--navy3)', borderRadius:8, padding:10, marginBottom:8 }}>
                          <div style={{ fontSize:10, color:'var(--amber)', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:8 }}>EDIT FUEL ENTRY</div>
                          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginBottom:8 }}>
                            <button onClick={() => setEditFuelType('fleet')} style={{ padding:'8px 0', borderRadius:8, border:'none', cursor:'pointer', fontFamily:'var(--font-head)', fontWeight:700, fontSize:11, background:editFuelType==='fleet'?'var(--amber)':'var(--navy2)', color:editFuelType==='fleet'?'var(--navy)':'var(--grey)' }}>FLEET CARD</button>
                            <button onClick={() => setEditFuelType('pocket')} style={{ padding:'8px 0', borderRadius:8, border:'none', cursor:'pointer', fontFamily:'var(--font-head)', fontWeight:700, fontSize:11, background:editFuelType==='pocket'?'#1565c0':'var(--navy2)', color:editFuelType==='pocket'?'#fff':'var(--grey)' }}>OUT OF POCKET</button>
                          </div>
                          <input type="date" value={editFuelDate} onChange={e => setEditFuelDate(e.target.value)} style={{ ...inputStyle, marginBottom:8 }} />
                          <input type="text" inputMode="decimal" placeholder="0.00" value={editFuelAmount} onChange={e => setEditFuelAmount(e.target.value)} style={{ ...inputStyle, marginBottom:8, fontSize:18, fontWeight:700, fontFamily:'var(--font-head)' }} />
                          <input type="text" placeholder="Notes (optional)" value={editFuelNotes} onChange={e => setEditFuelNotes(e.target.value)} style={{ ...inputStyle, marginBottom:8 }} />
                          <input type="text" inputMode="numeric" placeholder="Odometer" value={editFuelOdo} onChange={e => setEditFuelOdo(e.target.value.replace(/[^0-9]/g,''))} style={{ ...inputStyle, marginBottom:10 }} />
                          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                            <button onClick={cancelEditFuel} style={{ padding:'10px 0', borderRadius:8, border:'1px solid var(--border)', background:'transparent', color:'var(--grey)', fontFamily:'var(--font-head)', fontWeight:700, fontSize:12, cursor:'pointer' }}>CANCEL</button>
                            <button onClick={saveEditFuel} disabled={editFuelSaving || !editFuelAmount} style={{ padding:'10px 0', borderRadius:8, border:'none', background:editFuelSaving||!editFuelAmount?'#555':'#4caf50', color:'#fff', fontFamily:'var(--font-head)', fontWeight:900, fontSize:12, cursor:'pointer' }}>{editFuelSaving ? 'SAVING...' : 'SAVE'}</button>
                          </div>
                        </div>
                      ) : (
                      <div key={f.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', paddingBottom:6 }}>
                        <div>
                          <span style={{ fontSize:11, color:f.fuel_type==='fleet'?'var(--amber)':'#1565c0', fontFamily:'var(--font-head)', fontWeight:700 }}>{f.fuel_type==='fleet'?'FLEET':'POCKET'}</span>
                          <span style={{ fontSize:11, color:'var(--grey)', marginLeft:6 }}>{f.entry_date}</span>
                          {f.notes && <span style={{ fontSize:10, color:'var(--grey)', marginLeft:6 }}>{f.notes}</span>}
                          {Number(f.odometer) > 0 && <span style={{ fontSize:10, color:'var(--amber)', marginLeft:6, fontFamily:'var(--font-head)', fontWeight:700 }}>{Number(f.odometer).toLocaleString()} mi</span>}
                        </div>
                        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                          <span style={{ fontFamily:'var(--font-head)', fontWeight:700, color:f.fuel_type==='fleet'?'var(--red)':'#1565c0' }}>{fmt(f.amount)}</span>
                          <button onClick={() => startEditFuel(f)} style={{ background:'transparent', border:'none', color:'var(--amber)', cursor:'pointer', fontSize:12, padding:'0 2px', fontFamily:'var(--font-head)', fontWeight:700 }}>EDIT</button>
                          <button onClick={() => deleteFuelEntry(f.id)} style={{ background:'transparent', border:'none', color:'#666', cursor:'pointer', fontSize:14, padding:'0 2px' }}>X</button>
                        </div>
                      </div>
                      )
                    ))}
                  </div>
                )}

                {/* Carrier advances for this driver (all-time list w/ repaid toggle) */}
                {advList.length > 0 && (
                  <div style={{marginTop:8,paddingTop:8,borderTop:'1px solid var(--border)'}}>
                    <div style={{ fontSize:10, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.06em', marginBottom:6 }}>CARRIER ADVANCES</div>
                    {advList.map(a => (
                      <div key={a.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', paddingBottom:6 }}>
                        <div>
                          <span style={{ fontSize:11, color:'#e65100', fontFamily:'var(--font-head)', fontWeight:700, textTransform:'uppercase' }}>{a.reason||'general'}</span>
                          <span style={{ fontSize:11, color:'var(--grey)', marginLeft:6 }}>{a.advance_date}</span>
                          {a.notes && <span style={{ fontSize:10, color:'var(--grey)', marginLeft:6 }}>{a.notes}</span>}
                          {a.repaid ? <span style={{ fontSize:9, color:'#2e7d32', marginLeft:6, fontWeight:700 }}>REPAID</span> : null}
                        </div>
                        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                          <span style={{ fontFamily:'var(--font-head)', fontWeight:700, color:a.repaid?'var(--grey)':'#e65100' }}>{fmt(a.amount)}</span>
                          <button onClick={() => toggleAdvanceRepaid(a)} style={{ background:'transparent', border:'none', color:a.repaid?'var(--grey)':'#4caf50', cursor:'pointer', fontSize:11, padding:'0 2px', fontFamily:'var(--font-head)', fontWeight:700 }}>{a.repaid?'REOPEN':'REPAID'}</button>
                          <button onClick={() => deleteCarrierAdvance(a.id)} style={{ background:'transparent', border:'none', color:'#666', cursor:'pointer', fontSize:14, padding:'0 2px' }}>X</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Weekly paystub button (driver settlement stub) */}
                <button
                  onClick={() => setShowPaystub(dn)}
                  style={{ width:'100%', marginTop:12, padding:'12px 0', borderRadius:8, border:'none', background: color, color:'#fff', fontFamily:'var(--font-head)', fontWeight:900, fontSize:13, cursor:'pointer', letterSpacing:'0.06em' }}
                >
                  WEEKLY PAYSTUB - {dn}
                </button>

                {/* View full statement button */}
                <button
                  onClick={() => setShowStatement(dn)}
                  style={{ width:'100%', marginTop:8, padding:'10px 0', borderRadius:8, border:'1px solid ' + color, background:'transparent', color, fontFamily:'var(--font-head)', fontWeight:700, fontSize:12, cursor:'pointer', letterSpacing:'0.06em' }}
                >
                  VIEW FULL STATEMENT - {dn}
                </button>
              </div>
            )
          })}

          {/* Fuel entry form */}
          <button
            onClick={() => {
              setShowFuelDrawer(p => !p)
              setFuelDate(new Date().toISOString().split('T')[0])
              setFuelAmount(''); setFuelNotes(''); setFuelType('fleet')
              setFuelReceiptB64(null); setFuelPreview(null)
            }}
            style={{ width:'100%', padding:'12px 0', borderRadius:10, border:'none', marginBottom:12, fontFamily:'var(--font-head)', fontWeight:900, fontSize:13, cursor:'pointer', background: showFuelDrawer ? 'var(--navy3)' : '#1a3a1a', color: showFuelDrawer ? 'var(--grey)' : '#4caf50', letterSpacing:'0.06em' }}
          >
            {showFuelDrawer ? 'X CANCEL FUEL ENTRY' : '\u26FD ADD FUEL ENTRY'}
          </button>

          {showFuelDrawer && (
            <div className="card" style={{ marginBottom:12, border:'1px solid #2a4a2a' }}>
              <div style={{ fontFamily:'var(--font-head)', fontSize:12, color:'#4caf50', letterSpacing:'0.1em', marginBottom:12 }}>NEW FUEL ENTRY</div>
              {isBookkeeper && (
                <div style={{ marginBottom:12 }}>
                  <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:6 }}>DRIVER</div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                    {driverNames.map(d => (
                      <button key={d} onClick={() => setFuelDriver(d)} style={{ padding:'10px 0', borderRadius:8, border:'none', cursor:'pointer', fontFamily:'var(--font-head)', fontWeight:700, fontSize:13, background: fuelDriver===d?colorFor(d):'var(--navy3)', color: fuelDriver===d?'#fff':'var(--grey)' }}>{d}</button>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ marginBottom:12 }}>
                <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:6 }}>FUEL TYPE</div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                  <button onClick={() => setFuelType('fleet')} style={{ padding:'10px 0', borderRadius:8, border:'none', cursor:'pointer', fontFamily:'var(--font-head)', fontWeight:700, fontSize:12, background:fuelType==='fleet'?'var(--amber)':'var(--navy3)', color:fuelType==='fleet'?'var(--navy)':'var(--grey)' }}>FLEET CARD</button>
                  <button onClick={() => setFuelType('pocket')} style={{ padding:'10px 0', borderRadius:8, border:'none', cursor:'pointer', fontFamily:'var(--font-head)', fontWeight:700, fontSize:12, background:fuelType==='pocket'?'#1565c0':'var(--navy3)', color:fuelType==='pocket'?'#fff':'var(--grey)' }}>OUT OF POCKET</button>
                </div>
                <div style={{ fontSize:10, color:'var(--grey)', marginTop:6, fontFamily:'var(--font-head)' }}>{fuelType==='fleet'?'Fleet card — deducted from driver pay':'Driver paid — tracked for tax purposes only'}</div>
              </div>
              <div style={{ marginBottom:12 }}>
                <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:6 }}>DATE</div>
                <input type="date" value={fuelDate} onChange={e => setFuelDate(e.target.value)} style={inputStyle} />
              </div>
              <div style={{ marginBottom:12 }}>
                <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:6 }}>AMOUNT ($)</div>
                <input type="text" inputMode="decimal" placeholder="0.00" value={fuelAmount} onChange={e => setFuelAmount(e.target.value)} style={{ ...inputStyle, fontSize:22, fontWeight:700, fontFamily:'var(--font-head)' }} />
              </div>
              <div style={{ marginBottom:12 }}>
                <button onClick={() => fuelFileRef.current.click()} disabled={fuelScanning} style={{ width:'100%', padding:'10px 0', borderRadius:8, border:'1px solid var(--border)', background:'var(--navy3)', color:fuelScanning?'var(--grey)':'var(--white)', fontFamily:'var(--font-head)', fontWeight:700, fontSize:13, cursor:'pointer' }}>{fuelScanning?'Scanning...':'Scan Receipt (optional)'}</button>
                {fuelPreview && (
                  <div style={{ marginTop:8, position:'relative' }}>
                    <img src={fuelPreview} alt="Receipt" style={{ width:'100%', borderRadius:6, border:'1px solid var(--border)', maxHeight:120, objectFit:'cover' }} />
                    <button onClick={() => { setFuelPreview(null); setFuelReceiptB64(null) }} style={{ position:'absolute', top:4, right:4, background:'rgba(0,0,0,0.7)', color:'#fff', border:'none', borderRadius:4, padding:'2px 8px', cursor:'pointer', fontSize:12 }}>X</button>
                  </div>
                )}
              </div>
              <div style={{ marginBottom:14 }}>
                <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:6 }}>NOTES (optional)</div>
                <input type="text" placeholder="e.g. Fleet card week of May 21" value={fuelNotes} onChange={e => setFuelNotes(e.target.value)} style={inputStyle} />
              </div>
              <div style={{ marginBottom:14 }}>
                <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:6 }}>ODOMETER (optional)</div>
                <input type="text" inputMode="numeric" placeholder="e.g. 1029463" value={fuelOdo} onChange={e => setFuelOdo(e.target.value.replace(/[^0-9]/g,''))} style={inputStyle} />
              </div>
              <button onClick={saveFuelEntry} disabled={fuelSaving||!fuelAmount} style={{ width:'100%', padding:'12px 0', borderRadius:10, border:'none', cursor:'pointer', fontFamily:'var(--font-head)', fontWeight:900, fontSize:14, background:fuelSaving||!fuelAmount?'#555':'#4caf50', color:'#fff', letterSpacing:'0.06em' }}>
                {fuelSaving ? 'SAVING...' : 'SAVE FUEL ENTRY'}
              </button>
            </div>
          )}

          {/* Carrier advance entry form */}
          <button
            onClick={() => {
              setShowAdvDrawer(p => !p)
              setAdvDate(new Date().toISOString().split('T')[0])
              setAdvAmount(''); setAdvNotes(''); setAdvReason('repair')
            }}
            style={{ width:'100%', padding:'12px 0', borderRadius:10, border:'none', marginBottom:12, fontFamily:'var(--font-head)', fontWeight:900, fontSize:13, cursor:'pointer', background: showAdvDrawer ? 'var(--navy3)' : '#3a2a1a', color: showAdvDrawer ? 'var(--grey)' : '#ffab40', letterSpacing:'0.06em' }}
          >
            {showAdvDrawer ? 'X CANCEL CARRIER ADVANCE' : '\uD83D\uDCB0 ADD CARRIER ADVANCE'}
          </button>

          {showAdvDrawer && (
            <div className="card" style={{ marginBottom:12, border:'1px solid #4a3a2a' }}>
              <div style={{ fontFamily:'var(--font-head)', fontSize:12, color:'#ffab40', letterSpacing:'0.1em', marginBottom:6 }}>NEW CARRIER ADVANCE</div>
              <div style={{ fontSize:10, color:'var(--grey)', marginBottom:12, fontFamily:'var(--font-head)' }}>Direct carrier-to-driver loan — reduces the driver's balance until repaid. Separate from broker comdata advances.</div>
              {isBookkeeper && (
                <div style={{ marginBottom:12 }}>
                  <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:6 }}>DRIVER</div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                    {driverNames.map(d => (
                      <button key={d} onClick={() => setAdvDriver(d)} style={{ padding:'10px 0', borderRadius:8, border:'none', cursor:'pointer', fontFamily:'var(--font-head)', fontWeight:700, fontSize:13, background: advDriver===d?colorFor(d):'var(--navy3)', color: advDriver===d?'#fff':'var(--grey)' }}>{d}</button>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ marginBottom:12 }}>
                <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:6 }}>REASON</div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:6 }}>
                  {REASONS.map(r => (
                    <button key={r} onClick={() => setAdvReason(r)} style={{ padding:'9px 0', borderRadius:8, border:'none', cursor:'pointer', fontFamily:'var(--font-head)', fontWeight:700, fontSize:10, letterSpacing:'0.04em', textTransform:'uppercase', background:advReason===r?'#ffab40':'var(--navy3)', color:advReason===r?'var(--navy)':'var(--grey)' }}>{r}</button>
                  ))}
                </div>
              </div>
              <div style={{ marginBottom:12 }}>
                <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:6 }}>DATE</div>
                <input type="date" value={advDate} onChange={e => setAdvDate(e.target.value)} style={inputStyle} />
              </div>
              <div style={{ marginBottom:12 }}>
                <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:6 }}>AMOUNT ($)</div>
                <input type="text" inputMode="decimal" placeholder="0.00" value={advAmount} onChange={e => setAdvAmount(e.target.value)} style={{ ...inputStyle, fontSize:22, fontWeight:700, fontFamily:'var(--font-head)' }} />
              </div>
              <div style={{ marginBottom:14 }}>
                <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:6 }}>NOTES (optional)</div>
                <input type="text" placeholder="e.g. Breakdown in Cheyenne — wired Comdata" value={advNotes} onChange={e => setAdvNotes(e.target.value)} style={inputStyle} />
              </div>
              <button onClick={saveCarrierAdvance} disabled={advSaving||!advAmount} style={{ width:'100%', padding:'12px 0', borderRadius:10, border:'none', cursor:'pointer', fontFamily:'var(--font-head)', fontWeight:900, fontSize:14, background:advSaving||!advAmount?'#555':'#ff9800', color:'#fff', letterSpacing:'0.06em' }}>
                {advSaving ? 'SAVING...' : 'SAVE CARRIER ADVANCE'}
              </button>
            </div>
          )}

          {/* Driver payment entry form — pay-side. Records a cash/check paid to the
              driver; reconciled FIFO against oldest unpaid billed load. Does NOT
              touch load cards or load.status (work-product side). Owner/bookkeeper. */}
          <button
            onClick={() => {
              setShowPayDrawer(p => !p)
              setPayDate(new Date().toISOString().split('T')[0])
              setPayAmount(''); setPayReference(''); setPayNotes(''); setPayMethod('check')
            }}
            style={{ width:'100%', padding:'12px 0', borderRadius:10, border:'none', marginBottom:12, fontFamily:'var(--font-head)', fontWeight:900, fontSize:13, cursor:'pointer', background: showPayDrawer ? 'var(--navy3)' : '#1a2e1a', color: showPayDrawer ? 'var(--grey)' : '#69f0ae', letterSpacing:'0.06em' }}
          >
            {showPayDrawer ? 'X CANCEL PAYMENT' : '\uD83D\uDCB5 ADD PAYMENT TO DRIVER'}
          </button>

          {showPayDrawer && (
            <div className="card" style={{ marginBottom:12, border:'1px solid #2a4a2a' }}>
              <div style={{ fontFamily:'var(--font-head)', fontSize:12, color:'#69f0ae', letterSpacing:'0.1em', marginBottom:6 }}>NEW PAYMENT TO DRIVER</div>
              <div style={{ fontSize:10, color:'var(--grey)', marginBottom:12, fontFamily:'var(--font-head)' }}>Cash or check paid to the driver. Applied to the driver's OLDEST unpaid billed load first, then cascades forward.</div>
              {isBookkeeper && (
                <div style={{ marginBottom:12 }}>
                  <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:6 }}>DRIVER</div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                    {driverNames.map(d => (
                      <button key={d} onClick={() => setPayDriver(d)} style={{ padding:'10px 0', borderRadius:8, border:'none', cursor:'pointer', fontFamily:'var(--font-head)', fontWeight:700, fontSize:13, background: payDriver===d?colorFor(d):'var(--navy3)', color: payDriver===d?'#fff':'var(--grey)' }}>{d}</button>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ marginBottom:12 }}>
                <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:6 }}>METHOD</div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:6 }}>
                  {['cash','check','other'].map(m => (
                    <button key={m} onClick={() => setPayMethod(m)} style={{ padding:'9px 0', borderRadius:8, border:'none', cursor:'pointer', fontFamily:'var(--font-head)', fontWeight:700, fontSize:11, letterSpacing:'0.04em', textTransform:'uppercase', background:payMethod===m?'#69f0ae':'var(--navy3)', color:payMethod===m?'var(--navy)':'var(--grey)' }}>{m}</button>
                  ))}
                </div>
              </div>
              <div style={{ marginBottom:12 }}>
                <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:6 }}>DATE</div>
                <input type="date" value={payDate} onChange={e => setPayDate(e.target.value)} style={inputStyle} />
              </div>
              <div style={{ marginBottom:12 }}>
                <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:6 }}>AMOUNT ($)</div>
                <input type="text" inputMode="decimal" placeholder="0.00" value={payAmount} onChange={e => setPayAmount(e.target.value)} style={{ ...inputStyle, fontSize:22, fontWeight:700, fontFamily:'var(--font-head)' }} />
              </div>
              <div style={{ marginBottom:12 }}>
                <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:6 }}>REFERENCE (check # — optional)</div>
                <input type="text" placeholder="e.g. 1042" value={payReference} onChange={e => setPayReference(e.target.value)} style={inputStyle} />
              </div>
              <div style={{ marginBottom:14 }}>
                <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:6 }}>NOTES (optional)</div>
                <input type="text" placeholder="e.g. Settlement week ending 7/4" value={payNotes} onChange={e => setPayNotes(e.target.value)} style={inputStyle} />
              </div>
              <button onClick={saveDriverPayment} disabled={paySaving||!payAmount} style={{ width:'100%', padding:'12px 0', borderRadius:10, border:'none', cursor:'pointer', fontFamily:'var(--font-head)', fontWeight:900, fontSize:14, background:paySaving||!payAmount?'#555':'#00c853', color:'#fff', letterSpacing:'0.06em' }}>
                {paySaving ? 'SAVING...' : 'SAVE PAYMENT'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
