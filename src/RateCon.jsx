// src/RateCon.jsx
// (c) dbappsystems.com | daddyboyapps.com

import { useState, useRef } from 'react'
import { api as apiClient } from './api.js'

export default function RateCon({ load, setLoad, driver, showToast, onNext }) {
  const [scanning, setScanning] = useState(false)
  const [scanned,  setScanned]  = useState(false)
  const fileRef = useRef()

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
      // Invoice.jsx can save load_stops rows and fire the IFTA route after save.
      stops:         Array.isArray(data.stops) ? data.stops : [],
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

      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        showToast(files.length > 1
          ? `📡 Scanning page ${i + 1} of ${files.length}...`
          : '📡 Scanning...')

        const base64    = await toBase64(file)
        const mediaType = file.type
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

      if (!Object.keys(merged).length) {
        showToast('❌ No data found in document')
        return
      }

      setLoad(prev => ({ ...prev, ...merged }))
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

  const ready = load.broker_name && load.origin && load.destination && load.base_pay

  return (
    <div>
      <div style={{ marginBottom: 16, display:'flex', alignItems:'center', gap: 8 }}>
        <span style={{ fontFamily:'var(--font-head)', fontSize:13, color:'var(--grey)', letterSpacing:'0.1em', textTransform:'uppercase' }}>Driver</span>
        <span className="badge">{driver}</span>
      </div>

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
