// src/RateConQueue.jsx
// (c) dbappsystems.com | daddyboyapps.com
//
// RATE CON QUEUE — the resting place.
//   A rate con arrives days before the load can be billed. It gets uploaded
//   HERE, ahead of time, and rests HERE in its own screen (never cluttering the
//   billing/scan page). Each con is driver-walled by the worker (tenant +
//   driver) in the rate_confirmations table + R2, status='pending'.
//
//   OPEN scans it (2026-07-05): tapping OPEN on a queued con does NOT open a
//   browser tab — it hands the con to the scan page (RateCon.jsx) via the
//   onScanRc prop. App.jsx stashes the con, switches to the scan sub-view, and
//   the SAME scanner that runs a camera photo runs this queued con. On a
//   successful scan the row links off (status='linked') and drops out of this
//   queue automatically. The × still deletes.
//
//   This screen is purely additive — it owns no settlement, tax, or load math.
//   It only banks documents and hands them to the scanner or removes them.

import { useState, useRef, useEffect } from 'react'
import { api as apiClient } from './api.js'

export default function RateConQueue({ driver, showToast, onBack, onScanRc }) {
  const [rows, setRows]           = useState([])
  const [loading, setLoading]     = useState(true)
  const [uploading, setUploading] = useState(false)
  const uploadRef = useRef()

  useEffect(() => { load() /* eslint-disable-next-line */ }, [driver])

  async function load() {
    setLoading(true)
    try {
      const data = await apiClient('/api/ratecons/' + encodeURIComponent(driver) + '?status=pending')
      setRows(Array.isArray(data) ? data : [])
    } catch {
      setRows([])
    } finally {
      setLoading(false)
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

  async function handleUpload(e) {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    setUploading(true)
    try {
      for (const file of files) {
        // Decide PDF by the file's real first bytes (iOS type/name unreliable).
        const head = new Uint8Array(await file.slice(0, 5).arrayBuffer())
        const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46
        const mediaType = isPdf ? 'application/pdf' : (file.type || 'image/jpeg')
        const base64 = await toBase64(file)
        await apiClient('/api/ratecons', { method: 'POST', json: { driver, base64, mediaType } })
      }
      showToast(files.length > 1 ? ('✅ ' + files.length + ' rate cons queued') : '✅ Rate con queued')
      await load()
    } catch (err) {
      showToast('❌ ' + ((err && err.message) || 'Upload failed').slice(0, 60))
    } finally {
      setUploading(false)
      if (uploadRef.current) uploadRef.current.value = ''
    }
  }

  // OPEN → scan. Hand the queued con to the scan page; the scanner there fetches
  // its bytes, runs OCR, and links the row off the queue on success.
  function scanRc(rc) {
    if (typeof onScanRc === 'function') onScanRc(rc)
  }

  async function deleteRc(id) {
    try {
      await apiClient('/api/ratecons/' + id, { method: 'DELETE' })
      await load()
    } catch (err) {
      showToast('❌ ' + ((err && err.message) || 'Delete failed').slice(0, 60))
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 16, display:'flex', alignItems:'center', gap: 8 }}>
        <span style={{ fontFamily:'var(--font-head)', fontSize:13, color:'var(--grey)', letterSpacing:'0.1em', textTransform:'uppercase' }}>Driver</span>
        <span className="badge">{driver}</span>
      </div>

      <div className="card">
        <div className="section-title">📥 Rate Con Queue — Upload Now, Recall at Billing</div>
        <input
          ref={uploadRef}
          type="file"
          accept="application/pdf,image/*"
          capture="environment"
          multiple
          style={{ display:'none' }}
          onChange={handleUpload}
        />
        <button
          className="scan-btn"
          style={{ width:'100%' }}
          onClick={() => uploadRef.current.click()}
          disabled={uploading}
        >
          {uploading ? 'UPLOADING…' : '⬆ UPLOAD / TAKE PHOTO OF RATE CON'}
        </button>
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--grey)' }}>
          Bank a rate con the day it arrives. It waits here until you bill that load — then tap OPEN to scan it into billing.
        </div>
      </div>

      <div className="card">
        <div className="section-title">Waiting in the Queue</div>

        {loading ? (
          <div style={{ fontSize:13, color:'var(--grey)', padding:'8px 2px' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ fontSize:13, color:'var(--grey)', padding:'8px 2px' }}>
            No rate cons waiting. Upload one above to bank it for later billing.
          </div>
        ) : (
          rows.map(rc => (
            <div
              key={rc.id}
              style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8, padding:'12px 14px',
                       borderRadius:10, background:'var(--navy3)', border:'1px solid var(--border)' }}
            >
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontFamily:'var(--font-head)', fontWeight:900, fontSize:14, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                  📄 {rc.broker_name || rc.load_number || 'Rate Con'}
                </div>
                <div style={{ fontSize:11, color:'var(--grey)', marginTop:2 }}>
                  {(rc.uploaded_at || '').slice(0, 10)}
                </div>
              </div>
              <button
                className="scan-btn secondary"
                style={{ width:'auto', padding:'6px 12px', margin:0 }}
                onClick={() => scanRc(rc)}
              >
                OPEN
              </button>
              <button
                onClick={() => deleteRc(rc.id)}
                aria-label="Delete rate con"
                style={{ width:32, height:32, flexShrink:0, borderRadius:8, cursor:'pointer',
                         background:'transparent', border:'1px solid var(--border)', color:'var(--grey)', fontWeight:900 }}
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>

      {typeof onBack === 'function' && (
        <button
          className="scan-btn secondary"
          style={{ width:'100%' }}
          onClick={onBack}
        >
          ← BACK
        </button>
      )}
    </div>
  )
}
