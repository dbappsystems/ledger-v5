// src/RateCon.jsx
// (c) dbappsystems.com | daddyboyapps.com
//
// BOOK NOW, BILL LATER (2026-07-03):
//   The rate confirmation is the load's CONTRACT — it must be stored the moment
//   the load is booked, not discarded after OCR. This screen now supports two
//   exits from the same scan:
//     • SAVE AS BOOKED — creates the load in D1 immediately with
//       status='booked' (no receipts yet), saves the scanned stops to
//       load_stops (Worker geocodes), fires route-ifta so state miles ledger
//       up right away, and stores the assembled RC PDF to R2 via
//       POST /api/ratecon-pdf. Booked loads are excluded from ALL settlement,
//       tax, and bookkeeper math until billed (see App.jsx prop filters and
//       Maintenance.jsx settlement fetch).
//     • NEXT → INVOICE — the original bill-at-delivery flow, unchanged. The
//       scanned page bytes ride along on load.rc_pages so Invoice.jsx can
//       store the RC PDF at billing time (STEP 1c).
//   A PENDING BOOKED LOADS picker sits at the top: tapping a booked load
//   pre-fills every field and carries booked_id so Invoice.jsx PATCHes the
//   existing row to status='invoiced' instead of inserting a duplicate.
//
// MATH INTEGRITY: a booked row is written with net_pay=0 and all line-item
//   totals 0 — earnings do not exist until the load is invoiced. The live
//   settlement formula (netPay = base + lumpers + incidentals + detention +
//   pallets − comdata) runs once, at billing, exactly as before.

import { useState, useRef, useEffect } from 'react'
import { jsPDF } from 'jspdf'
import { api as apiClient } from './api.js'

// ── RC PDF ASSEMBLY + R2 STORE ──────────────────────────────────────────────
// Shared by RateCon (SAVE AS BOOKED) and Invoice.jsx (STEP 1c bill-time store).
// pages: [{ kind:'image', dataUrl, w, h } | { kind:'pdf', base64 }]
// Never throws to the caller's main flow — callers invoke non-blocking.
export async function uploadRateConPdf(loadId, pages) {
  if (!loadId || !Array.isArray(pages) || pages.length === 0) return false
  let base64 = null
  // A single scanned PDF IS the rate con — store it byte-for-byte.
  if (pages.length === 1 && pages[0].kind === 'pdf' && pages[0].base64) {
    base64 = pages[0].base64
  } else {
    // Assemble photo pages into one letter-size PDF (same fit math as the
    // invoice's addScanPage). A raw PDF inside a mixed set gets a named
    // placeholder page so the document records it — mirrors the BOL rule
    // that a page is never silently lost.
    const doc = new jsPDF({ unit: 'pt', format: 'letter' })
    const pageW = 612, pageH = 792, pad = 24
    let first = true
    for (const p of pages) {
      if (!first) doc.addPage()
      first = false
      if (p.kind === 'image' && p.dataUrl && p.w && p.h) {
        const ratio = Math.min((pageW - pad * 2) / p.w, (pageH - pad * 2) / p.h)
        const imgW  = Math.round(p.w * ratio)
        const imgH  = Math.round(p.h * ratio)
        doc.addImage(p.dataUrl, 'JPEG', Math.round((pageW - imgW) / 2), Math.round((pageH - imgH) / 2), imgW, imgH)
      } else {
        doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.setTextColor(0, 0, 0)
        doc.text('RATE CONFIRMATION PAGE', pageW / 2, pageH / 2 - 8, { align: 'center' })
        doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(120, 120, 120)
        doc.text('Original PDF page on file with the carrier.', pageW / 2, pageH / 2 + 10, { align: 'center' })
      }
    }
    base64 = doc.output('datauristring').split(',')[1]
  }
  const res = await apiClient('/api/ratecon-pdf', { method: 'POST', json: { base64, loadId } })
  return !!(res && res.ok)
}

export default function RateCon({ load, setLoad, driver, showToast, onNext, onBooked }) {
  const [scanning, setScanning] = useState(false)
  const [scanned,  setScanned]  = useState(false)
  const [booking,  setBooking]  = useState(false)
  const [bookedLoads, setBookedLoads] = useState([])
  const fileRef = useRef()

  // ── PENDING BOOKED LOADS ─────────────────────────────────
  // Booked earlier, delivering now: pick it up here to bill it. Fetch is
  // self-contained and non-fatal — the screen works fine if it fails.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const data = await apiClient('/api/loads')
        if (!alive || !Array.isArray(data)) return
        const mine = data.filter(l =>
          l.status === 'booked' &&
          (l.driver || '').toUpperCase() === (driver || '').toUpperCase()
        )
        setBookedLoads(mine)
      } catch { /* non-fatal */ }
    })()
    return () => { alive = false }
  }, [driver])

  function pickBooked(row) {
    setLoad(prev => ({
      ...prev,
      booked_id:     row.id,
      broker_name:   row.broker_name   || '',
      broker_email:  row.broker_email  || '',
      load_number:   row.load_number   || '',
      origin:        row.origin        || '',
      destination:   row.destination   || '',
      pickup_date:   row.pickup_date   || '',
      delivery_date: row.delivery_date || '',
      base_pay:      row.base_pay != null ? String(row.base_pay) : '',
      // Stops + RC PDF were saved at booking — do not re-save at billing.
      stops:    [],
      rc_pages: [],
    }))
    setScanned(true)
    showToast('✅ Booked load loaded — review, then NEXT to bill it')
  }

  // Parse one OCR JSON result into a normalized load-fields object.
  function parseResult(json) {
    if (json.error) {
      throw new Error((json.detail || json.error).toString().slice(0, 80))
    }
    let raw = json.result || ''
    raw = raw.replace(/```json/gi, '').replace(/```/gi, '').trim()
    const start = raw.indexOf('{')
    const end   = raw.lastIndexOf('}')
    if (start === -1 || end === -1) {
      throw new Error('No data found in document')
    }
    const data = JSON.parse(raw.substring(start, end + 1))
    return {
      broker_name:   data.broker_name        || data.broker   || '',
      load_number:   data.broker_load_number || data.loadnum  || '',
      origin:        data.pickup_location    || data.pickup   || '',
      destination:   data.delivery_location  || data.delivery || '',
      pickup_date:   data.pickup_date        || '',
      delivery_date: data.delivery_date      || data.deldate  || '',
      base_pay:      data.base_pay           || data.rate     || '',
      // Multi-stop IFTA: the worker's rateconf prompt now returns every pickup
      // and delivery as its own object in run order. Carried on the load so
      // the booking path (here) or Invoice.jsx can save load_stops rows and
      // fire the IFTA route after save.
      stops:         Array.isArray(data.stops) ? data.stops : [],
    }
  }

  // iOS type/name are unreliable — decide PDF by the file's real first bytes.
  async function sniffIsPdf(file) {
    try {
      const head  = await file.slice(0, 5).arrayBuffer()
      const bytes = new Uint8Array(head)
      return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
    } catch { return false }
  }

  // Build one rc_pages entry from a scanned file. Photos are downscaled to
  // max 2000px JPEG so the stored contract PDF stays a sane size; a PDF file
  // keeps its raw bytes. Never throws — a failed page returns null and the
  // scan continues (the OCR already succeeded on the original bytes).
  async function capturePage(file, base64) {
    try {
      if (await sniffIsPdf(file)) return { kind: 'pdf', base64 }
      const dataUrl = 'data:' + (file.type || 'image/jpeg') + ';base64,' + base64
      const img = await new Promise((res, rej) => {
        const i = new Image()
        i.onload = () => res(i); i.onerror = rej
        i.src = dataUrl
      })
      const MAX = 2000
      const scale = Math.min(1, MAX / Math.max(img.width, img.height))
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      canvas.getContext('2d').drawImage(img, 0, 0, w, h)
      return { kind: 'image', dataUrl: canvas.toDataURL('image/jpeg', 0.85), w, h }
    } catch (err) {
      console.error('RC page capture error:', err)
      return null
    }
  }

  async function handleFile(e) {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    setScanning(true)

    try {
      // Accumulate fields across all pages. Earlier non-empty values win;
      // later pages only fill blanks so a clean page never overwrites good data.
      const merged = {}
      const fields = [
        'broker_name', 'load_number', 'origin', 'destination',
        'pickup_date', 'delivery_date', 'base_pay',
      ]
      const rcPages = []

      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        showToast(files.length > 1
          ? `📡 Scanning page ${i + 1} of ${files.length}...`
          : '📡 Scanning...')

        const base64    = await toBase64(file)
        const mediaType = file.type

        // Capture the page bytes for the stored RC PDF regardless of whether
        // the OCR can read it — the contract document must never be lost.
        const page = await capturePage(file, base64)
        if (page) rcPages.push(page)

        const json      = await apiClient('/api/ocr', {
          method: 'POST',
          json:   { base64, mediaType, mode: 'rateconf' },
        })

        let parsed
        try {
          parsed = parseResult(json)
        } catch (pageErr) {
          // Don't kill the whole batch for one bad page.
          showToast(`⚠️ Page ${i + 1}: ${pageErr.message.slice(0, 60)}`)
          continue
        }

        for (const f of fields) {
          if (!merged[f] && parsed[f]) merged[f] = parsed[f]
        }
        // stops is an array, not a text field: first page that yields stops wins
        // (a multi-page RC lists all stops on page 1; later pages are terms/BOL).
        if ((!merged.stops || !merged.stops.length) && parsed.stops && parsed.stops.length) {
          merged.stops = parsed.stops
        }
      }

      if (!Object.keys(merged).length && !rcPages.length) {
        showToast('❌ No data found in document')
        return
      }

      // A fresh scan is a NEW load, never a booked pickup: clear any booked_id
      // so billing cannot PATCH the wrong row.
      setLoad(prev => ({ ...prev, ...merged, rc_pages: rcPages, booked_id: null }))
      setScanned(true)
      showToast(files.length > 1
        ? `✅ ${files.length} pages scanned & merged!`
        : '✅ Rate con scanned!')
    } catch (err) {
      showToast('❌ ' + err.message.slice(0, 80))
    } finally {
      setScanning(false)
      // Reset so re-selecting the same files fires onChange again.
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function toBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload  = () => resolve(reader.result.split(',')[1])
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  function update(field, val) {
    setLoad(prev => ({ ...prev, [field]: val }))
  }

  // ── SAVE AS BOOKED ───────────────────────────────────────
  // Creates the load NOW at RC arrival: D1 row (status='booked', zero
  // earnings), load_stops + route-ifta (IFTA miles ledger immediately),
  // stored RC PDF. Billing later PATCHes this same row.
  async function saveAsBooked() {
    if (booking) return
    setBooking(true)
    showToast('💾 Booking load...')
    let bookedId = null
    try {
      const data = await apiClient('/api/loads', {
        method: 'POST',
        json: {
          driver,
          broker_name:      load.broker_name   || '',
          broker_email:     load.broker_email  || '',
          load_number:      load.load_number   || '',
          origin:           load.origin        || '',
          destination:      load.destination   || '',
          pickup_date:      load.pickup_date   || '',
          delivery_date:    load.delivery_date || '',
          base_pay:         parseFloat(load.base_pay) || 0,
          lumper_total:     0,
          incidental_total: 0,
          comdata_total:    0,
          detention:        0,
          pallets:          0,
          net_pay:          0,   // earnings do not exist until invoiced
          notes:            load.notes || '',
          bol_count:        0,
          lumpers:          [],
          incidentals:      [],
          comdatas:         [],
          status:           'booked',
        },
      })
      if (!data || !data.id) throw new Error((data && data.error) || 'Save failed')
      bookedId = data.id
    } catch (err) {
      showToast('⚠️ Booking failed: ' + (err.message || '').slice(0, 60))
      setBooking(false)
      return
    }

    // Stops + IFTA routing fire at booking so state miles ledger immediately.
    // Same non-blocking rule as Invoice.jsx STEP 1b: nothing here may undo the
    // booking; failures log + toast once and the flow continues. route-ifta is
    // idempotent, so a missed run can be re-fired without duplicating miles.
    try {
      let stopRows = Array.isArray(load.stops) ? load.stops : []
      if (!stopRows.length) {
        stopRows = []
        if (load.origin)      stopRows.push({ type: 'pickup',   city: load.origin,      date: load.pickup_date   || '' })
        if (load.destination) stopRows.push({ type: 'delivery', city: load.destination, date: load.delivery_date || '' })
      }
      if (stopRows.length >= 2) {
        showToast('🗺️ Saving stops for IFTA...')
        for (let i = 0; i < stopRows.length; i++) {
          const s = stopRows[i]
          await apiClient('/api/load-stop', {
            method: 'POST',
            json: {
              load_id:   bookedId,
              sequence:  i + 1,
              stop_type: s.type === 'pickup' ? 'pickup' : 'delivery',
              address:   s.address || '',
              city:      s.city    || '',
              state:     s.state   || '',
              zip:       s.zip     || '',
              appointment: s.date  || '',
            },
          })
        }
        apiClient('/api/loads/' + bookedId + '/route-ifta', { method: 'POST' })
          .catch(err => console.error('route-ifta error:', err))
      }
    } catch (err) {
      console.error('load-stop save error:', err)
      showToast('⚠️ IFTA stops skipped: ' + (err.message || '').slice(0, 50))
    }

    // Store the contract. Non-blocking: the load is booked either way; a
    // failed store just means the RC can be re-scanned onto the load later.
    try {
      const stored = await uploadRateConPdf(bookedId, load.rc_pages)
      showToast(stored ? '✅ Load booked — rate con stored!' : '✅ Load booked!')
    } catch (err) {
      console.error('ratecon store error:', err)
      showToast('✅ Load booked (rate con store failed — rescan later)')
    }

    setBooking(false)
    if (typeof onBooked === 'function') onBooked()
  }

  const ready = load.broker_name && load.origin && load.destination && load.base_pay
  const isBookedPickup = !!load.booked_id

  return (
    <div>
      <div style={{ marginBottom: 16, display:'flex', alignItems:'center', gap: 8 }}>
        <span style={{ fontFamily:'var(--font-head)', fontSize:13, color:'var(--grey)', letterSpacing:'0.1em', textTransform:'uppercase' }}>Driver</span>
        <span className="badge">{driver}</span>
      </div>

      {bookedLoads.length > 0 && (
        <div className="card">
          <div className="section-title">⏳ Pending Booked Loads — Tap to Bill</div>
          {bookedLoads.map(row => (
            <button
              key={row.id}
              onClick={() => pickBooked(row)}
              style={{ display:'block', width:'100%', textAlign:'left', marginBottom:8, padding:'12px 14px', borderRadius:10, cursor:'pointer',
                       background: load.booked_id === row.id ? 'var(--amber)' : 'var(--navy3)',
                       border: '1px solid ' + (load.booked_id === row.id ? 'var(--amber)' : 'var(--border)'),
                       color: load.booked_id === row.id ? '#0A1628' : 'var(--white)' }}
            >
              <div style={{ fontFamily:'var(--font-head)', fontWeight:900, fontSize:14 }}>
                #{row.load_number || '-'} — {row.broker_name || 'Unknown Broker'}
              </div>
              <div style={{ fontSize:12, opacity:0.8, marginTop:2 }}>
                {row.origin || '-'} → {row.destination || '-'}
              </div>
            </button>
          ))}
          <div style={{ fontSize:12, color:'var(--grey)' }}>
            Picking a booked load pre-fills everything below — hit NEXT to add receipts and bill it.
          </div>
        </div>
      )}

      <div className="card">
        <div className="section-title">① Rate Confirmation</div>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,image/*"
          multiple
          style={{ display:'none' }}
          onChange={handleFile}
        />
        <button
          className={`scan-btn ${scanned ? 'success' : ''}`}
          onClick={() => fileRef.current.click()}
          disabled={scanning}
        >
          {scanning ? (
            <>
              <svg className="spinning" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{width:22,height:22}}>
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
              </svg>
              SCANNING...
            </>
          ) : scanned ? (
            <>✓ SCANNED — TAP TO RESCAN</>
          ) : (
            <>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{width:22,height:22}}>
                <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/>
                <circle cx="12" cy="13" r="4"/>
              </svg>
              SCAN RATE CONFIRMATION
            </>
          )}
        </button>
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--grey)' }}>
          Multi-page rate con? Select all photos at once — pages merge into one load.
        </div>
      </div>

      <div className="card">
        <div className="section-title">② Load Details — Edit if Needed</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <div className="field-row" style={{ gridColumn:'1 / -1' }}>
            <div className="field-label">Broker Name</div>
            <input value={load.broker_name} onChange={e=>update('broker_name',e.target.value)} placeholder="e.g. CH Robinson" />
          </div>
          <div className="field-row" style={{ gridColumn:'1 / -1' }}>
            <div className="field-label">Broker Email</div>
            <input value={load.broker_email} onChange={e=>update('broker_email',e.target.value)} placeholder="billing@broker.com" type="email" />
          </div>
          <div className="field-row">
            <div className="field-label">Load #</div>
            <input value={load.load_number} onChange={e=>update('load_number',e.target.value)} placeholder="Load number" />
          </div>
          <div className="field-row">
            <div className="field-label">Base Pay</div>
            <input value={load.base_pay} onChange={e=>update('base_pay',e.target.value)} placeholder="0.00" type="number" inputMode="decimal" />
          </div>
          <div className="field-row">
            <div className="field-label">Origin</div>
            <input value={load.origin} onChange={e=>update('origin',e.target.value)} placeholder="City, ST" />
          </div>
          <div className="field-row">
            <div className="field-label">Destination</div>
            <input value={load.destination} onChange={e=>update('destination',e.target.value)} placeholder="City, ST" />
          </div>
          <div className="field-row">
            <div className="field-label">Pickup Date</div>
            <input value={load.pickup_date} onChange={e=>update('pickup_date',e.target.value)} placeholder="MM/DD/YYYY" />
          </div>
          <div className="field-row">
            <div className="field-label">Delivery Date</div>
            <input value={load.delivery_date} onChange={e=>update('delivery_date',e.target.value)} placeholder="MM/DD/YYYY" />
          </div>
        </div>
      </div>

      {/* Book now (RC just arrived) — hidden when billing a booked pickup. */}
      {!isBookedPickup && (
        <button
          className="scan-btn secondary"
          onClick={saveAsBooked}
          disabled={!ready || booking}
          style={{ opacity: (ready && !booking) ? 1 : 0.4, marginBottom: 10 }}
        >
          {booking ? 'BOOKING...' : '📌 SAVE AS BOOKED — BILL LATER'}
        </button>
      )}

      <button
        className="scan-btn"
        onClick={onNext}
        disabled={!ready}
        style={{ opacity: ready ? 1 : 0.4 }}
      >
        NEXT — ADD RECEIPTS & GENERATE INVOICE →
      </button>
    </div>
  )
}
