// src/Loads.jsx
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — Load list, leaderboard, edit, ACH, delete
//
// AUTH MIGRATION: load PATCH + DELETE now go through the token api() client.
//   DELETE preserves the 403 ownership message via err.status. The `api` URL
//   prop is gone; the invoice link uses apiUrl() + a ?t=<token> query.
//
// INVOICE PDFs:
//   VIEW INVOICE PDF regenerates from load data (generateInvoicePDF).
//   SAVE TO V5 copies a load's legacy V4 stored PDF into the V5 bucket via
//   POST /api/invoice/:id/save (worker reads R2_V4, writes R2). Uses the
//   logged-in session token, so the owner taps it right in the app — no file
//   to open, no second browser.
//
// WHITE-LABEL (DONE): this file no longer hardcodes a two-driver BRUCE/TIM
//   model. The filter tabs, the all-time leaderboard, and per-driver card
//   colors are now driven by the tenant's OWN driver list via useDrivers()
//   (arbitrary length). colorFor(name) supplies each driver's color; names/
//   drivers supply the tabs and leaderboard rows. The ACH (⚡) action is now
//   available on every unpaid load (the old TIM-only name gate is removed) —
//   per-tenant decision: always-on, no name check.
//   generateCorrectedPDF() carrier identity comes from tenantSettings
//   (display_name, legal_name, remit_address, mc_number, dot_number,
//   support_email), identical to Invoice.jsx, with NEUTRAL/blank fallbacks
//   only. The corrected-invoice filename is neutral ('CORRECTED-Invoice-').
//
// 2026-06-11: RATE CON CHRONOLOGY — loads are listed and dated by DELIVERY DATE.
//             parseAppDate() handles MM/DD/YYYY, M/D/YYYY, MM/DD/YY and YYYY-MM-DD.

import { useState, useEffect } from 'react'
import { jsPDF } from 'jspdf'
import { api as apiClient, apiUrl, getToken } from './api.js'
import { useDrivers } from './useDrivers.js'

// Safely turn a D1 column that may be an array, a JSON string, null, or ''
// into a real array. Never throws.
function asArray(val) {
  if (Array.isArray(val)) return val
  if (typeof val === 'string') {
    const s = val.trim()
    if (!s) return []
    try {
      const parsed = JSON.parse(s)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

// Darken a #rrggbb hex by a factor (0..1) for the card header background.
function darkenHex(hex, factor = 0.28) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim())
  if (!m) return '#1A3A5C'
  const n = parseInt(m[1], 16)
  const r = Math.round(((n >> 16) & 255) * factor)
  const g = Math.round(((n >> 8) & 255) * factor)
  const b = Math.round((n & 255) * factor)
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
}

// Parse any date format that exists in this app's data into a Date at
// local noon. Handles: YYYY-MM-DD | MM/DD/YYYY | M/D/YYYY | MM/DD/YY.
function parseAppDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null
  const s = dateStr.trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s.substring(0,10) + 'T12:00:00')
    return isNaN(d.getTime()) ? null : d
  }
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (m) {
    const month = parseInt(m[1], 10)
    const day   = parseInt(m[2], 10)
    let year    = parseInt(m[3], 10)
    if (m[3].length === 2) year += 2000
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    const d = new Date(year, month - 1, day, 12, 0, 0)
    return isNaN(d.getTime()) ? null : d
  }
  return null
}

export default function Loads({ loads, setLoads, driver, showToast, fetchLoads, tenantSettings }) {

  // White-label driver source: tabs, leaderboard, and colors all read from the
  // tenant's own driver list (falls back to seeded BRUCE/TIM if unavailable).
  const { names: driverNames, colorFor } = useDrivers()

  const [view,          setView]          = useState('all')
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [deleting,      setDeleting]      = useState(false)
  const [updating,      setUpdating]      = useState(null)
  const [editIdx,       setEditIdx]       = useState(null)
  const [editData,      setEditData]      = useState(null)
  const [showAchPanel,  setShowAchPanel]  = useState(null)
  const [achReceivedAmt,setAchReceivedAmt]= useState('')
  const [savingV5,      setSavingV5]      = useState(null)   // loadId currently saving (or 'ALL')
  const [savedV5,       setSavedV5]       = useState({})     // { [loadId]: true } saved this session

  // ── LOAD ACTIONS ──────────────────────────────────────────
  async function patchLoad(load, localIdx, fields) {
    setUpdating(load.id || localIdx)
    try {
      if (load.id) {
        try {
          await apiClient('/api/loads/' + load.id, {
            method: 'PATCH',
            json:   fields,
          })
        } catch (e) {
          showToast('Update failed: ' + e.message)
          setUpdating(null); return false
        }
        try { await fetchLoads() } catch {}
        if (fields.status === 'paid')   showToast('Marked as paid!')
        if (fields.status === 'billed') showToast('Marked as billed!')
        setUpdating(null); return true
      } else {
        setLoads(prev => prev.map((l,i) => i === localIdx ? { ...l, ...fields } : l))
        if (fields.status === 'paid')   showToast('Marked as paid!')
        if (fields.status === 'billed') showToast('Marked as billed!')
        setUpdating(null); return true
      }
    } catch (err) {
      showToast('Update failed: ' + err.message)
      setUpdating(null); return false
    }
  }

  async function markPaidACH(load, localIdx, received) {
    const netPay = parseFloat(load.netPay || load.net_pay) || 0
    const rcvd   = parseFloat(received) || 0
    if (rcvd <= 0) { showToast('Enter the amount you received'); return }
    await patchLoad(load, localIdx, { status:'paid', ach_payment:1, ach_received:rcvd })
    setShowAchPanel(null); setAchReceivedAmt('')
    const fee = Math.max(0, netPay - rcvd)
    if (fee > 0) showToast('ACH Paid! Broker fee: $' + fee.toFixed(2))
    else showToast('ACH Paid!')
  }

  async function deleteLoad(load, localIdx) {
    setDeleting(true)
    try {
      if (load.id) {
        try {
          await apiClient('/api/loads/' + load.id, {
            method: 'DELETE',
            json:   { driver },
          })
        } catch (e) {
          let errMsg = e.message || 'Server error'
          if (e.status === 403) errMsg = 'You can only delete your own loads'
          showToast('Delete failed: ' + errMsg)
          setDeleting(false); return
        }
        await fetchLoads()
      } else {
        setLoads(prev => prev.filter((_,i) => i !== localIdx))
      }
      showToast('Load deleted')
      setConfirmDelete(null)
      if (editIdx === localIdx) { setEditIdx(null); setEditData(null) }
    } catch (err) { showToast('Delete failed: ' + err.message) }
    finally { setDeleting(false) }
  }

  // ── SAVE LEGACY V4 INVOICE INTO V5 ────────────────────────
  // POST /api/invoice/:id/save — worker reads the stored PDF from the V4 bucket
  // and writes it into the V5 bucket. Returns {ok,savedBytes} or {ok,alreadyInV5}.
  // Returns 'saved' | 'already' | 'none' | 'error' so the bulk runner can tally.
  async function saveOneToV5(load) {
    if (!load.id) return 'error'
    try {
      const res = await apiClient('/api/invoice/' + load.id + '/save', { method: 'POST', json: {} })
      setSavedV5(prev => ({ ...prev, [load.id]: true }))
      if (res && res.alreadyInV5) return 'already'
      return 'saved'
    } catch (e) {
      const msg = (e && e.message) ? e.message : ''
      if (msg.indexOf('No stored V4') !== -1) return 'none'
      return 'error'
    }
  }

  async function saveToV5(load) {
    if (!load.id) { showToast('Save this load first'); return }
    setSavingV5(load.id)
    const r = await saveOneToV5(load)
    setSavingV5(null)
    if (r === 'saved')        showToast('Saved to V5!')
    else if (r === 'already') showToast('Already in V5')
    else if (r === 'none')    showToast('No V4 file for this load')
    else                      showToast('Save failed — try again')
    try { await fetchLoads() } catch {}
  }

  // Bulk: save every visible load that has a V4 invoice into V5, one by one.
  async function saveAllVisibleToV5() {
    const targets = sortedLoads.filter(l => l.id)
    if (targets.length === 0) { showToast('No saved loads to copy'); return }
    setSavingV5('ALL')
    let saved = 0, already = 0, none = 0, error = 0
    for (const l of targets) {
      const r = await saveOneToV5(l)
      if (r === 'saved') saved++
      else if (r === 'already') already++
      else if (r === 'none') none++
      else error++
    }
    setSavingV5(null)
    showToast('V5 copy done — ' + saved + ' saved, ' + already + ' already, ' + none + ' no-file, ' + error + ' failed')
    try { await fetchLoads() } catch {}
  }

  // ── EDIT HELPERS ──────────────────────────────────────────
  function openEdit(load, localIdx) {
    if (editIdx === localIdx) { setEditIdx(null); setEditData(null); return }
    setEditIdx(localIdx)
    setEditData({
      base_pay:    String(load.base_pay    || ''),
      detention:   String(load.detention   || ''),
      pallets:     String(load.pallets     || ''),
      notes:       String(load.notes       || ''),
      lumpers:     asArray(load.lumpers).map(i => ({ ...i, amount: String(i.amount || '0') })),
      incidentals: asArray(load.incidentals).map(i => ({ ...i, amount: String(i.amount || '0') })),
      comdatas:    asArray(load.comdatas).map(i => ({ ...i, amount: String(i.amount || '0') })),
    })
  }
  function closeEdit() { setEditIdx(null); setEditData(null) }
  function updateItemAmount(type, idx, val) {
    setEditData(prev => ({ ...prev, [type]: prev[type].map((item,i) => i === idx ? { ...item, amount: val } : item) }))
  }
  function removeEditItem(type, idx) {
    setEditData(prev => ({ ...prev, [type]: prev[type].filter((_,i) => i !== idx) }))
  }
  function addEditItem(type) {
    setEditData(prev => ({ ...prev, [type]: [...prev[type], { amount: '0.00', label: 'Manual entry', dataUrl: null, base64: null, w: 0, h: 0 }] }))
  }
  function editNetPreview() {
    if (!editData) return 0
    const base_pay     = parseFloat(editData.base_pay)  || 0
    const detention    = parseFloat(editData.detention)  || 0
    const pallets      = parseFloat(editData.pallets)    || 0
    const lumperTotal  = editData.lumpers.reduce((s,i)     => s + (parseFloat(i.amount)||0), 0)
    const incTotal     = editData.incidentals.reduce((s,i) => s + (parseFloat(i.amount)||0), 0)
    const comdataTotal = editData.comdatas.reduce((s,i)    => s + (parseFloat(i.amount)||0), 0)
    return (base_pay + lumperTotal + incTotal + detention + pallets) - comdataTotal
  }

  // ── CORRECTED PDF ─────────────────────────────────────────
  function generateCorrectedPDF(load, data, newNetPay) {
    const ts            = tenantSettings || {}
    const coName        = (ts.display_name && ts.display_name.trim())
                          || (ts.legal_name && ts.legal_name.trim())
                          || ''
    const coLegalName   = (ts.legal_name && ts.legal_name.trim())
                          || (ts.display_name && ts.display_name.trim())
                          || ''
    const coAddress     = (ts.remit_address && ts.remit_address.trim())
                          || ''
    const coMc          = (ts.mc_number && String(ts.mc_number).trim())
                          ? 'MC#' + String(ts.mc_number).trim()
                          : ''
    const coDot         = (ts.dot_number && String(ts.dot_number).trim())
                          ? 'DOT#' + String(ts.dot_number).trim()
                          : ''
    const coContactLine = (ts.support_email && ts.support_email.trim())
                          || ''
    const coSignature   = (ts.legal_name && ts.legal_name.trim())
                          || (ts.display_name && ts.display_name.trim())
                          || ''

    const base_pay  = parseFloat(data.base_pay)  || 0
    const detention = parseFloat(data.detention) || 0
    const pallets   = parseFloat(data.pallets)   || 0
    const subtotal  = base_pay
      + data.lumpers.reduce((s,i)     => s + (parseFloat(i.amount)||0), 0)
      + data.incidentals.reduce((s,i) => s + (parseFloat(i.amount)||0), 0)
      + detention + pallets
    const fmtN = n => '$' + (parseFloat(n)||0).toFixed(2)
    const doc = new jsPDF({ unit: 'pt', format: 'letter' })
    const W = 612, M = 40; let y = 0
    doc.setFontSize(22); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    doc.text(coName, W/2, 50, { align:'center' })
    doc.setDrawColor(180,180,180); doc.setLineWidth(0.5); doc.line(M,58,W-M,58); y = 75
    doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(180,0,0)
    doc.text('** CORRECTED INVOICE **', W/2, y, { align:'center' }); y += 14
    doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    doc.text(coLegalName, M, y); doc.setFont('helvetica','normal')
    doc.text(coAddress, M, y+12)
    const idLine = coDot ? (coMc + '  ' + coDot) : coMc
    doc.text(idLine, M, y+24)
    doc.text(coContactLine, M, y+36)
    doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(100,100,100)
    doc.text('DATE SENT', W-M, y, { align:'right' }); doc.line(W-160, y+3, W-M, y+3)
    doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    doc.text(new Date().toLocaleDateString('en-US'), W-M, y+16, { align:'right' }); y += 60
    doc.setDrawColor(180,180,180); doc.line(M,y,W-M,y); y += 14
    doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(100,100,100)
    doc.text('BILL TO', M, y); doc.text('LOAD #', W/2, y); y += 12
    doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    const bl = doc.splitTextToSize(load.broker_name || '-', 220)
    doc.text(bl, M, y); doc.text(load.load_number || '-', W/2, y); y += bl.length * 14 + 6
    doc.setDrawColor(180,180,180); doc.line(M,y,W-M,y); y += 14
    doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(100,100,100)
    doc.text('PICK UP LOCATION', M, y); doc.text('DELIVERY LOCATION', W/2, y); y += 12
    doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    const ol = doc.splitTextToSize(load.origin || '-', 220)
    const dl = doc.splitTextToSize(load.destination || '-', 220)
    doc.text(ol, M, y); doc.text(dl, W/2, y); y += Math.max(ol.length, dl.length) * 14 + 6
    doc.setDrawColor(180,180,180); doc.line(M,y,W-M,y); y += 14
    doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(100,100,100)
    doc.text('DELIVERY DATE', M, y); y += 12
    doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    doc.text(load.delivery_date || '-', M, y); y += 20
    doc.setDrawColor(180,180,180); doc.line(M,y,W-M,y); y += 18
    doc.setFontSize(9); doc.setFont('helvetica','italic'); doc.setTextColor(80,80,80)
    doc.text('Please remit payment amount for transport services', M, y); y += 20
    function li(label, amount, bold, red) {
      doc.setFontSize(10); doc.setFont('helvetica', bold ? 'bold' : 'normal')
      doc.setTextColor(red ? 180 : 0, 0, 0)
      doc.text(label, M, y); doc.text(amount, W-M, y, { align:'right' }); y += 18
    }
    li('Trucking Rate', fmtN(base_pay), false, false)
    data.lumpers.forEach((l,i)     => li('Lumper Receipt '+(i+1), fmtN(parseFloat(l.amount)), false, false))
    data.incidentals.forEach((l,i) => li('Incidental '+(i+1),     fmtN(parseFloat(l.amount)), false, false))
    if (detention > 0) li('Detention', fmtN(detention), false, false)
    if (pallets   > 0) li('Pallets',   fmtN(pallets),   false, false)
    y += 4; doc.setDrawColor(0,0,0); doc.setLineWidth(1); doc.line(M,y,W-M,y); y += 14
    doc.setFontSize(11); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    doc.text('SUBTOTAL', M, y); doc.text(fmtN(subtotal), W-M, y, { align:'right' }); y += 20
    doc.setLineWidth(0.5); doc.setDrawColor(180,180,180); doc.line(M,y,W-M,y); y += 14
    data.comdatas.forEach((c,i) => li('Comdata / Express Code '+(i+1), '-'+fmtN(parseFloat(c.amount)), false, true))
    y += 8; doc.setFillColor(30,30,30); doc.rect(M,y,W-M*2,28,'F')
    doc.setFontSize(13); doc.setFont('helvetica','bold'); doc.setTextColor(255,255,255)
    doc.text('NET BILLABLE TOTAL', M+10, y+19); doc.text(fmtN(newNetPay), W-M-10, y+19, { align:'right' }); y += 48
    if (data.notes) {
      doc.setFontSize(9); doc.setFont('helvetica','italic'); doc.setTextColor(80,80,80)
      const nl = doc.splitTextToSize(data.notes, W-M*2); doc.text(nl, M, y); y += nl.length * 12 + 10
    }
    y += 10; doc.setFontSize(8); doc.setFont('helvetica','italic'); doc.setTextColor(150,0,0)
    doc.text('This is a corrected invoice superseding the original. Please discard any previous version.', M, y); y += 20
    doc.setFontSize(9); doc.setFont('helvetica','normal'); doc.setTextColor(80,80,80)
    doc.text('Thank You', W-M, y, { align:'right' }); y += 20
    doc.setFontSize(14); doc.setFont('helvetica','bolditalic'); doc.setTextColor(0,0,0)
    doc.text(coSignature, W-M, y, { align:'right' })
    doc.setFontSize(7); doc.setFont('helvetica','normal'); doc.setTextColor(160,160,160)
    doc.text('dbappsystems.com | daddyboyapps.com', W/2, 760, { align:'center' })
    doc.save('CORRECTED-Invoice-' + (load.load_number || 'draft') + '.pdf')
  }

  // ── INVOICE PDF (regenerated from load data) ──────────────
  function generateInvoicePDF(load) {
    const ts            = tenantSettings || {}
    const coName        = (ts.display_name && ts.display_name.trim())
                          || (ts.legal_name && ts.legal_name.trim()) || ''
    const coLegalName   = (ts.legal_name && ts.legal_name.trim())
                          || (ts.display_name && ts.display_name.trim()) || ''
    const coAddress     = (ts.remit_address && ts.remit_address.trim()) || ''
    const coMc          = (ts.mc_number && String(ts.mc_number).trim())
                          ? 'MC#' + String(ts.mc_number).trim() : ''
    const coDot         = (ts.dot_number && String(ts.dot_number).trim())
                          ? 'DOT#' + String(ts.dot_number).trim() : ''
    const coContactLine = (ts.support_email && ts.support_email.trim()) || ''
    const coSignature   = (ts.legal_name && ts.legal_name.trim())
                          || (ts.display_name && ts.display_name.trim()) || ''

    const lumpers     = asArray(load.lumpers)
    const incidentals = asArray(load.incidentals)
    const comdatas    = asArray(load.comdatas)
    const base_pay    = parseFloat(load.base_pay)  || 0
    const detention   = parseFloat(load.detention) || 0
    const pallets     = parseFloat(load.pallets)   || 0
    const netPay      = parseFloat(load.netPay || load.net_pay) || 0
    const subtotal    = base_pay
      + lumpers.reduce((s,i)     => s + (parseFloat(i.amount)||0), 0)
      + incidentals.reduce((s,i) => s + (parseFloat(i.amount)||0), 0)
      + detention + pallets
    const fmtN = n => '$' + (parseFloat(n)||0).toFixed(2)
    const doc = new jsPDF({ unit: 'pt', format: 'letter' })
    const W = 612, M = 40; let y = 0
    doc.setFontSize(22); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    doc.text(coName, W/2, 50, { align:'center' })
    doc.setDrawColor(180,180,180); doc.setLineWidth(0.5); doc.line(M,58,W-M,58); y = 80
    doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    doc.text(coLegalName, M, y); doc.setFont('helvetica','normal')
    doc.text(coAddress, M, y+12)
    const idLine = coDot ? (coMc + '  ' + coDot) : coMc
    doc.text(idLine, M, y+24)
    doc.text(coContactLine, M, y+36)
    doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(100,100,100)
    doc.text('DATE SENT', W-M, y, { align:'right' }); doc.line(W-160, y+3, W-M, y+3)
    doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    doc.text(new Date().toLocaleDateString('en-US'), W-M, y+16, { align:'right' }); y += 60
    doc.setDrawColor(180,180,180); doc.line(M,y,W-M,y); y += 14
    doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(100,100,100)
    doc.text('BILL TO', M, y); doc.text('LOAD #', W/2, y); y += 12
    doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    const bl = doc.splitTextToSize(load.broker_name || '-', 220)
    doc.text(bl, M, y); doc.text(load.load_number || '-', W/2, y); y += bl.length * 14 + 6
    doc.setDrawColor(180,180,180); doc.line(M,y,W-M,y); y += 14
    doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(100,100,100)
    doc.text('PICK UP LOCATION', M, y); doc.text('DELIVERY LOCATION', W/2, y); y += 12
    doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    const ol = doc.splitTextToSize(load.origin || '-', 220)
    const dl = doc.splitTextToSize(load.destination || '-', 220)
    doc.text(ol, M, y); doc.text(dl, W/2, y); y += Math.max(ol.length, dl.length) * 14 + 6
    doc.setDrawColor(180,180,180); doc.line(M,y,W-M,y); y += 14
    doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(100,100,100)
    doc.text('DELIVERY DATE', M, y); y += 12
    doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    doc.text(load.delivery_date || '-', M, y); y += 20
    doc.setDrawColor(180,180,180); doc.line(M,y,W-M,y); y += 18
    doc.setFontSize(9); doc.setFont('helvetica','italic'); doc.setTextColor(80,80,80)
    doc.text('Please remit payment amount for transport services', M, y); y += 20
    function li(label, amount, bold, red) {
      doc.setFontSize(10); doc.setFont('helvetica', bold ? 'bold' : 'normal')
      doc.setTextColor(red ? 180 : 0, 0, 0)
      doc.text(label, M, y); doc.text(amount, W-M, y, { align:'right' }); y += 18
    }
    li('Trucking Rate', fmtN(base_pay), false, false)
    lumpers.forEach((l,i)     => li('Lumper Receipt '+(i+1), fmtN(parseFloat(l.amount)), false, false))
    incidentals.forEach((l,i) => li('Incidental '+(i+1),     fmtN(parseFloat(l.amount)), false, false))
    if (detention > 0) li('Detention', fmtN(detention), false, false)
    if (pallets   > 0) li('Pallets',   fmtN(pallets),   false, false)
    y += 4; doc.setDrawColor(0,0,0); doc.setLineWidth(1); doc.line(M,y,W-M,y); y += 14
    doc.setFontSize(11); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    doc.text('SUBTOTAL', M, y); doc.text(fmtN(subtotal), W-M, y, { align:'right' }); y += 20
    doc.setLineWidth(0.5); doc.setDrawColor(180,180,180); doc.line(M,y,W-M,y); y += 14
    comdatas.forEach((c,i) => li('Comdata / Express Code '+(i+1), '-'+fmtN(parseFloat(c.amount)), false, true))
    y += 8; doc.setFillColor(30,30,30); doc.rect(M,y,W-M*2,28,'F')
    doc.setFontSize(13); doc.setFont('helvetica','bold'); doc.setTextColor(255,255,255)
    doc.text('NET BILLABLE TOTAL', M+10, y+19); doc.text(fmtN(netPay), W-M-10, y+19, { align:'right' }); y += 48
    if (load.notes) {
      doc.setFontSize(9); doc.setFont('helvetica','italic'); doc.setTextColor(80,80,80)
      const nl = doc.splitTextToSize(load.notes, W-M*2); doc.text(nl, M, y); y += nl.length * 12 + 10
    }
    y += 10; doc.setFontSize(9); doc.setFont('helvetica','normal'); doc.setTextColor(80,80,80)
    doc.text('Thank You', W-M, y, { align:'right' }); y += 20
    doc.setFontSize(14); doc.setFont('helvetica','bolditalic'); doc.setTextColor(0,0,0)
    doc.text(coSignature, W-M, y, { align:'right' })
    doc.setFontSize(7); doc.setFont('helvetica','normal'); doc.setTextColor(160,160,160)
    doc.text('dbappsystems.com | daddyboyapps.com', W/2, 760, { align:'center' })
    doc.save('Invoice-' + (load.load_number || 'draft') + '.pdf')
  }

  async function saveEdit(load, localIdx) {
    const newNetPay = editNetPreview()
    const fields = {
      base_pay: editData.base_pay, detention: editData.detention, pallets: editData.pallets,
      notes: editData.notes, lumpers: JSON.stringify(editData.lumpers),
      incidentals: JSON.stringify(editData.incidentals), comdatas: JSON.stringify(editData.comdatas),
      net_pay: newNetPay, edited: 1, edited_date: new Date().toISOString(),
    }
    const ok = await patchLoad(load, localIdx, fields)
    if (!ok) { showToast('Save failed — invoice not downloaded'); return }
    generateCorrectedPDF(load, editData, newNetPay)
    showToast('Corrected invoice downloaded!')
    closeEdit()
  }

  // ── HELPERS ───────────────────────────────────────────────
  function fmt(n)         { return '$' + (parseFloat(n)||0).toFixed(2) }
  function loadDate(load) { return load.delivery_date || load.date || load.created_at || null }
  function loadSortTime(load) {
    const d = parseAppDate(loadDate(load))
    return d ? d.getTime() : 0
  }
  // Open the stored PDF (V5, with V4 fallback in the worker) in a new tab.
  function viewStoredInvoice(load) {
    const t = getToken()
    const u = apiUrl('/api/invoice/' + load.id) + (t ? ('?t=' + encodeURIComponent(t)) : '')
    window.open(u, '_blank', 'noopener,noreferrer')
  }

  // ── COMPUTED ──────────────────────────────────────────────
  const leaderboard = driverNames.map(name => {
    const dLoads = loads.filter(l => l.driver === name)
    const total  = dLoads.reduce((s,l) => s + (parseFloat(l.netPay||l.net_pay)||0), 0)
    return { name, color: colorFor(name), count: dLoads.length, total }
  })
  const grandTotal = leaderboard.reduce((s,d) => s + d.total, 0)
  const rankedBoard = [...leaderboard].sort((a,b) => b.total - a.total)
  const topTotal    = rankedBoard.length ? rankedBoard[0].total : 0
  const leadersAtTop = rankedBoard.filter(d => d.total === topTotal && topTotal > 0)
  const leaderName   = leadersAtTop.length === 1 ? leadersAtTop[0].name : null

  const filteredLoads = view === 'all' ? loads : loads.filter(l => l.driver === view)
  const sortedLoads       = [...filteredLoads].sort((a,b) => loadSortTime(b) - loadSortTime(a))
  const totalNet          = filteredLoads.reduce((s,l) => s+(parseFloat(l.netPay||l.net_pay)||0), 0)
  const totalPaid         = filteredLoads.filter(l=>l.status==='paid').reduce((s,l) => s+(parseFloat(l.netPay||l.net_pay)||0), 0)
  const totalUnpaid       = totalNet - totalPaid

  const editInputStyle = {
    width:'100%', background:'var(--navy3)', border:'1px solid var(--border)',
    color:'var(--white)', borderRadius:8, padding:'8px 10px',
    fontSize:14, fontFamily:'var(--font-body)', boxSizing:'border-box',
  }

  // ── EMPTY STATE ───────────────────────────────────────────
  if (loads.length === 0) {
    return (
      <div className="empty-state">
        <div className="icon">📋</div><h3>NO LOADS YET</h3>
        <p>Complete and invoice a load to see it here</p>
      </div>
    )
  }

  // ── RENDER ────────────────────────────────────────────────
  const tabValues = ['all', ...driverNames]
  return (
    <div>
      {/* Filter tabs — ALL + one per tenant driver */}
      <div style={{ display:'grid', gridTemplateColumns:`repeat(${tabValues.length}, 1fr)`, gap:6, marginBottom:14 }}>
        {tabValues.map(v => (
          <button key={v} onClick={() => setView(v)} style={{
            padding:'9px 4px', borderRadius:8, border:'none',
            fontFamily:'var(--font-head)', fontWeight:700, fontSize:12,
            letterSpacing:'0.05em', cursor:'pointer',
            background: view === v ? 'var(--amber)' : 'var(--navy3)',
            color:       view === v ? 'var(--navy)'  : 'var(--grey)',
          }}>{v.toUpperCase()}</button>
        ))}
      </div>

      {/* Bulk save legacy V4 invoices into V5 for the current view */}
      <button onClick={saveAllVisibleToV5} disabled={savingV5==='ALL'} style={{
        display:'block', width:'100%', marginBottom:14, padding:'11px 0', borderRadius:9,
        border:'1px solid var(--amber)', background: savingV5==='ALL' ? 'var(--navy3)' : 'transparent',
        color:'var(--amber)', fontFamily:'var(--font-head)', fontWeight:800, fontSize:13,
        letterSpacing:'0.05em', cursor: savingV5==='ALL' ? 'default' : 'pointer',
      }}>{savingV5==='ALL' ? 'SAVING ALL TO V5…' : '⬇ SAVE ALL V4 INVOICES TO V5 (THIS VIEW)'}</button>

      {/* Leaderboard — one row per tenant driver, top earner crowned */}
      <div className="card" style={{ marginBottom:14 }}>
        <div className="section-title" style={{ marginBottom:10 }}>
          LEADERBOARD - ALL TIME
          {leaderName && <span style={{ marginLeft:8, fontSize:12, color:'var(--amber)' }}>{leaderName} IS WINNING!</span>}
        </div>
        <div style={{ display:'flex', height:18, borderRadius:9, overflow:'hidden', marginBottom:10, background:'var(--navy3)' }}>
          {leaderboard.map(d => {
            const pct = grandTotal > 0 ? (d.total / grandTotal) * 100 : (100 / (leaderboard.length || 1))
            return <div key={d.name} style={{ width:pct+'%', background:d.color, transition:'width 0.4s' }} />
          })}
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:10 }}>
          {leaderboard.map(d => (
            <div key={d.name} style={{ background:'var(--navy3)', borderRadius:8, padding:'10px 12px', borderLeft:'3px solid '+d.color }}>
              <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', marginBottom:4 }}>{d.name} {leaderName===d.name?'👑':''}</div>
              <div style={{ fontFamily:'var(--font-head)', fontSize:20, fontWeight:900, color:d.color }}>{fmt(d.total)}</div>
              <div style={{ fontSize:11, color:'var(--grey)', marginTop:2 }}>{d.count} load{d.count!==1?'s':''}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, marginBottom:14 }}>
        <div className="card" style={{ padding:12, textAlign:'center', marginBottom:0 }}>
          <div style={{ fontSize:10, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:4 }}>TOTAL</div>
          <div style={{ fontFamily:'var(--font-head)', fontSize:17, fontWeight:900, color:'var(--amber)' }}>{fmt(totalNet)}</div>
        </div>
        <div className="card" style={{ padding:12, textAlign:'center', marginBottom:0 }}>
          <div style={{ fontSize:10, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:4 }}>PAID</div>
          <div style={{ fontFamily:'var(--font-head)', fontSize:17, fontWeight:900, color:'var(--green)' }}>{fmt(totalPaid)}</div>
        </div>
        <div className="card" style={{ padding:12, textAlign:'center', marginBottom:0 }}>
          <div style={{ fontSize:10, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:4 }}>OWED</div>
          <div style={{ fontFamily:'var(--font-head)', fontSize:17, fontWeight:900, color:'var(--red)' }}>{fmt(totalUnpaid)}</div>
        </div>
      </div>

      {filteredLoads.length === 0 && (
        <div className="empty-state"><div className="icon">📋</div><h3>NO LOADS</h3><p>No loads found for this driver yet</p></div>
      )}

      {/* Load cards — rate con chronology, newest delivery first */}
      {sortedLoads.map((load, idx) => {
        const localIdx    = loads.indexOf(load)
        const isEditing   = editIdx === localIdx
        const isAchPanel  = showAchPanel === localIdx
        const loadId      = load.id || localIdx
        const netPay      = parseFloat(load.netPay || load.net_pay) || 0
        const basePay     = parseFloat(load.base_pay)   || 0
        const detention   = parseFloat(load.detention)  || 0
        const pallets     = parseFloat(load.pallets)    || 0
        const lumpers     = asArray(load.lumpers)
        const incidentals = asArray(load.incidentals)
        const comdatas    = asArray(load.comdatas)
        const lumperTot   = lumpers.reduce((s,i)     => s+(parseFloat(i.amount)||0), 0)
        const incTot      = incidentals.reduce((s,i) => s+(parseFloat(i.amount)||0), 0)
        const subtotal    = basePay + lumperTot + incTot + detention + pallets
        const bolCount    = load.bol_count || (load.bols && load.bols.length) || 0
        const dateObj     = parseAppDate(loadDate(load))
        const achFee      = load.ach_payment ? Math.max(0, netPay - (parseFloat(load.ach_received)||0)) : 0
        const achPreviewFee = achReceivedAmt ? Math.max(0, netPay - (parseFloat(achReceivedAmt)||0)) : 0
        const isSavingV5  = savingV5 === load.id
        const isSavedV5   = !!savedV5[load.id]
        // Per-driver colors from the tenant's own list (no name matching).
        const driverColor = colorFor(load.driver)
        const headerBg    = darkenHex(driverColor)
        return (
          <div key={load.id || idx} style={{ background:'var(--white)', borderRadius:10, marginBottom:14, overflow:'hidden', boxShadow:'0 2px 8px rgba(0,0,0,0.18)' }}>
            {/* Card header */}
            <div style={{ background:headerBg, padding:'10px 14px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <div style={{ padding:'2px 8px', borderRadius:10, fontSize:10, fontFamily:'var(--font-head)', fontWeight:700, background:driverColor, color:'#fff' }}>{load.driver||'-'}</div>
                <div style={{ fontSize:18, fontFamily:'var(--font-head)', fontWeight:900, color:'#fff', letterSpacing:'0.04em' }}>#{load.load_number||'-'}</div>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                {load.ach_payment && <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:4, background:'#e8f5e9', color:'#2e7d32' }}>⚡ ACH</span>}
                {bolCount > 0 && <div style={{ fontSize:10, color:'rgba(255,255,255,0.6)', fontFamily:'var(--font-head)' }}>{bolCount} BOL{bolCount!==1?'s':''}</div>}
                <span className={'status-chip ' + load.status}>{load.status}</span>
              </div>
            </div>
            {/* Card body */}
            <div style={{ padding:'12px 14px' }}>
              <div style={{ marginBottom:10 }}>
                <div style={{ fontSize:14, fontFamily:'var(--font-head)', fontWeight:900, color:'var(--navy)', marginBottom:2 }}>{load.broker_name||'Unknown Broker'}</div>
                <div style={{ fontSize:12, color:'#555', marginBottom:1 }}>{load.origin||'-'} → {load.destination||'-'}</div>
                <div style={{ fontSize:11, color:'#888' }}>
                  Delivered {dateObj ? dateObj.toLocaleDateString() : (loadDate(load) || '-')}
                  {(load.edited||load.edited_date) && <span style={{ marginLeft:6, color:'var(--amber)', fontSize:10, fontWeight:700 }}>EDITED {load.edited_date?new Date(load.edited_date).toLocaleDateString():''}</span>}
                </div>
              </div>
              <div style={{ borderTop:'1px solid #e0e0e0', marginBottom:8 }} />
              {/* Invoice lines */}
              <div style={{ fontSize:13, color:'var(--navy)' }}>
                {[
                  ['Trucking Rate', basePay],
                  ...lumpers.map((l,i)     => ['Lumper Receipt '+(i+1), parseFloat(l.amount)||0]),
                  ...incidentals.map((l,i) => ['Incidental '+(i+1),     parseFloat(l.amount)||0]),
                  ...(detention>0?[['Detention',detention]]:[]),
                  ...(pallets>0?[['Pallets',pallets]]:[]),
                ].map(([label,amount],i) => (
                  <div key={i} style={{ display:'flex', justifyContent:'space-between', paddingBottom:4 }}>
                    <span style={{ color:'#444' }}>{label}</span>
                    <span style={{ fontFamily:'var(--font-head)', fontWeight:600, color:'var(--navy)' }}>{fmt(amount)}</span>
                  </div>
                ))}
                <div style={{ borderTop:'1px solid #bbb', marginTop:4, marginBottom:4 }} />
                <div style={{ display:'flex', justifyContent:'space-between', paddingBottom:4 }}>
                  <span style={{ fontWeight:700, color:'var(--navy)' }}>Subtotal</span>
                  <span style={{ fontFamily:'var(--font-head)', fontWeight:700, color:'var(--navy)' }}>{fmt(subtotal)}</span>
                </div>
                {comdatas.map((c,i) => (
                  <div key={i} style={{ display:'flex', justifyContent:'space-between', paddingBottom:4 }}>
                    <span style={{ color:'#c62828' }}>Comdata / Express Code {i+1}</span>
                    <span style={{ fontFamily:'var(--font-head)', fontWeight:600, color:'#c62828' }}>-{fmt(parseFloat(c.amount)||0)}</span>
                  </div>
                ))}
                <div style={{ borderTop:'1px solid #333', marginTop:2 }} />
                <div style={{ borderTop:'1px solid #333', marginBottom:6 }} />
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <span style={{ fontSize:12, fontFamily:'var(--font-head)', fontWeight:900, color:'var(--navy)', letterSpacing:'0.04em' }}>NET BILLABLE TOTAL</span>
                  <span style={{ fontSize:20, fontFamily:'var(--font-head)', fontWeight:900, color:'var(--navy)' }}>{fmt(netPay)}</span>
                </div>
              </div>
              {/* PDF actions: regenerate, view stored (V5/V4), save V4→V5 */}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginTop:10 }}>
                <button onClick={() => generateInvoicePDF(load)} style={{ padding:'8px 0', borderRadius:8, background:'transparent', border:'1px solid var(--amber)', color:'var(--amber)', fontFamily:'var(--font-head)', fontWeight:700, fontSize:12, textAlign:'center', cursor:'pointer', letterSpacing:'0.04em' }}>VIEW INVOICE PDF</button>
                {load.id && (
                  <button onClick={() => saveToV5(load)} disabled={isSavingV5} style={{ padding:'8px 0', borderRadius:8, background: isSavedV5 ? '#e8f5e9' : 'transparent', border: isSavedV5 ? '1px solid #2e7d32' : '1px solid var(--navy)', color: isSavedV5 ? '#2e7d32' : 'var(--navy)', fontFamily:'var(--font-head)', fontWeight:700, fontSize:12, textAlign:'center', cursor: isSavingV5 ? 'default' : 'pointer', letterSpacing:'0.04em' }}>
                    {isSavingV5 ? 'SAVING…' : (isSavedV5 ? '✓ IN V5' : 'SAVE TO V5')}
                  </button>
                )}
              </div>
              {load.id && (
                <button onClick={() => viewStoredInvoice(load)} style={{ display:'block', width:'100%', marginTop:8, padding:'7px 0', borderRadius:8, background:'transparent', border:'1px solid var(--border)', color:'var(--grey)', fontFamily:'var(--font-head)', fontWeight:700, fontSize:11, textAlign:'center', cursor:'pointer', letterSpacing:'0.04em' }}>OPEN STORED PDF</button>
              )}
              {/* Action buttons */}
              <div style={{ display:'flex', gap:8, marginTop:10, flexWrap:'wrap' }}>
                {load.status !== 'billed' && load.status !== 'paid' && (
                  <button className="scan-btn secondary" style={{ flex:1, padding:'8px 12px', fontSize:12 }} disabled={updating===loadId} onClick={() => patchLoad(load,localIdx,{status:'billed'})}>{updating===loadId?'...':'MARK BILLED'}</button>
                )}
                {load.status !== 'paid' && (
                  <button className="scan-btn success" style={{ flex:1, padding:'8px 12px', fontSize:12 }} disabled={updating===loadId} onClick={() => { setShowAchPanel(null); setAchReceivedAmt(''); patchLoad(load,localIdx,{status:'paid'}) }}>{updating===loadId?'...':'MARK PAID'}</button>
                )}
                {load.status !== 'paid' && (
                  <button onClick={() => {
                    if (isAchPanel) { setShowAchPanel(null); setAchReceivedAmt('') }
                    else { setShowAchPanel(localIdx); setAchReceivedAmt('') }
                  }} style={{ padding:'8px 12px', borderRadius:8, fontSize:12, cursor:'pointer', fontFamily:'var(--font-head)', fontWeight:700, letterSpacing:'0.04em', background: isAchPanel?'#e8f5e9':'var(--navy3)', color: isAchPanel?'#2e7d32':'var(--grey)', border: isAchPanel?'1px solid #2e7d32':'1px solid var(--border)' }}>⚡ ACH</button>
                )}
                {load.status === 'paid' && !load.ach_payment && (
                  <div style={{ fontSize:12, color:'var(--green)', fontFamily:'var(--font-head)', fontWeight:700, paddingTop:4 }}>PAYMENT RECEIVED</div>
                )}
                {load.status === 'paid' && load.ach_payment && (
                  <div style={{ fontSize:11, color:'#2e7d32', fontFamily:'var(--font-head)', fontWeight:700, paddingTop:4 }}>
                    ⚡ ACH PAID — Received: {fmt(parseFloat(load.ach_received)||0)}
                    {achFee > 0 && <span style={{ color:'#e65100', marginLeft:6 }}>Fee: {fmt(achFee)}</span>}
                  </div>
                )}
                <button style={{ padding:'8px 12px', borderRadius:8, border:'1px solid var(--amber)', background:isEditing?'var(--amber)':'transparent', color:isEditing?'var(--navy)':'var(--amber)', fontSize:12, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }} onClick={() => openEdit(load,localIdx)}>{isEditing?'CLOSE':'EDIT'}</button>
                <button style={{ padding:'8px 12px', borderRadius:8, border:'1px solid #ccc', background:'transparent', color:'#999', fontSize:12, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }} onClick={() => setConfirmDelete(localIdx)}>DELETE</button>
              </div>
              {/* ACH Panel */}
              {isAchPanel && (
                <div style={{ marginTop:12, padding:14, background:'#f1f8e9', borderRadius:8, border:'1px solid #a5d6a7' }}>
                  <div style={{ fontFamily:'var(--font-head)', fontSize:12, color:'#2e7d32', letterSpacing:'0.08em', marginBottom:10 }}>⚡ ACH PAYMENT — CONFIRM RECEIVED AMOUNT</div>
                  <div style={{ fontSize:11, color:'#555', marginBottom:10 }}>Invoice total: <strong>{fmt(netPay)}</strong> — Broker deducted their fee before sending. Enter what actually hit the bank.</div>
                  <div style={{ marginBottom:8 }}>
                    <div style={{ fontSize:11, color:'#444', fontFamily:'var(--font-head)', marginBottom:4 }}>AMOUNT RECEIVED ($)</div>
                    <input type="text" inputMode="decimal" placeholder="0.00" value={achReceivedAmt} onChange={e => setAchReceivedAmt(e.target.value)} style={{ ...editInputStyle, fontSize:22, fontWeight:700, fontFamily:'var(--font-head)', background:'#fff', color:'#111', border:'1px solid #a5d6a7' }} />
                  </div>
                  {achReceivedAmt && parseFloat(achReceivedAmt) > 0 && (
                    <div style={{ background:'#fff', borderRadius:6, padding:'8px 12px', marginBottom:10, border:'1px solid #e0e0e0', fontSize:12 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                        <span style={{ color:'#555' }}>Received</span>
                        <span style={{ fontFamily:'var(--font-head)', fontWeight:700, color:'#2e7d32' }}>{fmt(parseFloat(achReceivedAmt))}</span>
                      </div>
                      <div style={{ display:'flex', justifyContent:'space-between' }}>
                        <span style={{ color:'#e65100' }}>Broker convenience fee</span>
                        <span style={{ fontFamily:'var(--font-head)', fontWeight:700, color:'#e65100' }}>{fmt(achPreviewFee)}</span>
                      </div>
                    </div>
                  )}
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                    <button onClick={() => { setShowAchPanel(null); setAchReceivedAmt('') }} style={{ padding:'10px 0', borderRadius:8, border:'1px solid #ccc', background:'transparent', color:'#888', fontFamily:'var(--font-head)', fontWeight:700, fontSize:13, cursor:'pointer' }}>CANCEL</button>
                    <button disabled={!achReceivedAmt||parseFloat(achReceivedAmt)<=0||updating===loadId} onClick={() => markPaidACH(load, localIdx, achReceivedAmt)} style={{ padding:'10px 0', borderRadius:8, border:'none', fontFamily:'var(--font-head)', fontWeight:900, fontSize:13, cursor:'pointer', background:(!achReceivedAmt||parseFloat(achReceivedAmt)<=0||updating===loadId)?'#ccc':'#2e7d32', color:'#fff' }}>{updating===loadId?'SAVING...':'CONFIRM PAID — ACH'}</button>
                  </div>
                </div>
              )}
              {/* Delete confirm */}
              {confirmDelete === localIdx && (
                <div style={{ marginTop:12, padding:12, background:'#fff3f3', borderRadius:8, border:'1px solid #e53935' }}>
                  <div style={{ fontSize:13, color:'#c62828', marginBottom:10, fontFamily:'var(--font-head)', fontWeight:700 }}>DELETE THIS LOAD? This cannot be undone.</div>
                  <div style={{ display:'flex', gap:8 }}>
                    <button disabled={deleting} onClick={() => deleteLoad(load,localIdx)} style={{ flex:1, padding:'10px 0', borderRadius:8, border:'none', background:deleting?'#ccc':'#e53935', color:'#fff', fontSize:13, fontFamily:'var(--font-head)', fontWeight:900, cursor:'pointer' }}>{deleting?'DELETING...':'CONFIRM DELETE'}</button>
                    <button disabled={deleting} onClick={() => setConfirmDelete(null)} style={{ flex:1, padding:'10px 0', borderRadius:8, border:'1px solid #ccc', background:'transparent', color:'#888', fontSize:13, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }}>CANCEL</button>
                  </div>
                </div>
              )}
              {/* Edit panel */}
              {isEditing && editData && (
                <div style={{ marginTop:16, paddingTop:16, borderTop:'1px solid #e0e0e0' }}>
                  <div style={{ fontFamily:'var(--font-head)', fontSize:12, color:'var(--amber)', letterSpacing:'0.1em', marginBottom:12 }}>EDIT INVOICE AMOUNTS</div>
                  <div style={{ marginBottom:12 }}>
                    <div style={{ fontSize:11, color:'#666', marginBottom:4, fontFamily:'var(--font-head)' }}>BASE PAY ($)</div>
                    <input style={editInputStyle} type="text" inputMode="decimal" value={editData.base_pay} onChange={e => setEditData(p=>({...p,base_pay:e.target.value}))} placeholder="0.00" />
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:12 }}>
                    <div>
                      <div style={{ fontSize:11, color:'#666', marginBottom:4, fontFamily:'var(--font-head)' }}>DETENTION ($)</div>
                      <input style={editInputStyle} type="text" inputMode="decimal" value={editData.detention} onChange={e => setEditData(p=>({...p,detention:e.target.value}))} placeholder="0.00" />
                    </div>
                    <div>
                      <div style={{ fontSize:11, color:'#666', marginBottom:4, fontFamily:'var(--font-head)' }}>PALLETS ($)</div>
                      <input style={editInputStyle} type="text" inputMode="decimal" value={editData.pallets} onChange={e => setEditData(p=>({...p,pallets:e.target.value}))} placeholder="0.00" />
                    </div>
                  </div>
                  <div style={{ marginBottom:12 }}>
                    <div style={{ fontSize:11, color:'#666', marginBottom:6, fontFamily:'var(--font-head)' }}>LUMPER RECEIPTS</div>
                    {editData.lumpers.map((item,i) => (
                      <div key={i} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                        <div style={{ fontSize:12, color:'#666', minWidth:70 }}>Lumper {i+1}</div>
                        <input style={{ ...editInputStyle, flex:1 }} type="text" inputMode="decimal" value={item.amount} onChange={e => updateItemAmount('lumpers',i,e.target.value)} placeholder="0.00" />
                        <button onClick={() => removeEditItem('lumpers',i)} style={{ background:'transparent', border:'1px solid #ccc', color:'#999', borderRadius:6, padding:'6px 10px', cursor:'pointer', fontSize:13, fontWeight:700 }}>x</button>
                      </div>
                    ))}
                    <button className="scan-btn secondary" style={{ width:'100%', padding:'8px', fontSize:12, marginTop:4 }} onClick={() => addEditItem('lumpers')}>+ ADD LUMPER</button>
                  </div>
                  <div style={{ marginBottom:12 }}>
                    <div style={{ fontSize:11, color:'#666', marginBottom:6, fontFamily:'var(--font-head)' }}>INCIDENTALS</div>
                    {editData.incidentals.map((item,i) => (
                      <div key={i} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                        <div style={{ fontSize:12, color:'#666', minWidth:70 }}>Inc. {i+1}</div>
                        <input style={{ ...editInputStyle, flex:1 }} type="text" inputMode="decimal" value={item.amount} onChange={e => updateItemAmount('incidentals',i,e.target.value)} placeholder="0.00" />
                        <button onClick={() => removeEditItem('incidentals',i)} style={{ background:'transparent', border:'1px solid #ccc', color:'#999', borderRadius:6, padding:'6px 10px', cursor:'pointer', fontSize:13, fontWeight:700 }}>x</button>
                      </div>
                    ))}
                    <button className="scan-btn secondary" style={{ width:'100%', padding:'8px', fontSize:12, marginTop:4 }} onClick={() => addEditItem('incidentals')}>+ ADD INCIDENTAL</button>
                  </div>
                  <div style={{ marginBottom:12 }}>
                    <div style={{ fontSize:11, color:'#666', marginBottom:6, fontFamily:'var(--font-head)' }}>COMDATA / EXPRESS CODES</div>
                    {editData.comdatas.map((item,i) => (
                      <div key={i} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                        <div style={{ fontSize:12, color:'#c62828', minWidth:70 }}>Comdata {i+1}</div>
                        <input style={{ ...editInputStyle, flex:1, borderColor:'#e57373' }} type="text" inputMode="decimal" value={item.amount} onChange={e => updateItemAmount('comdatas',i,e.target.value)} placeholder="0.00" />
                        <button onClick={() => removeEditItem('comdatas',i)} style={{ background:'transparent', border:'1px solid #ccc', color:'#999', borderRadius:6, padding:'6px 10px', cursor:'pointer', fontSize:13, fontWeight:700 }}>x</button>
                      </div>
                    ))}
                    <button className="scan-btn danger" style={{ width:'100%', padding:'8px', fontSize:12, marginTop:4 }} onClick={() => addEditItem('comdatas')}>+ ADD COMDATA / EXPRESS CODE</button>
                  </div>
                  <div style={{ marginBottom:16 }}>
                    <div style={{ fontSize:11, color:'#666', marginBottom:4, fontFamily:'var(--font-head)' }}>NOTES</div>
                    <textarea value={editData.notes} onChange={e => setEditData(p=>({...p,notes:e.target.value}))} placeholder="Notes..." style={{ ...editInputStyle, minHeight:60, resize:'vertical' }} />
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', background:'#f5f5f5', borderRadius:8, padding:'10px 14px', marginBottom:10, border:'1px solid #ddd' }}>
                    <span style={{ fontFamily:'var(--font-head)', fontSize:12, color:'#666' }}>UPDATED NET TOTAL</span>
                    <span style={{ fontFamily:'var(--font-head)', fontSize:20, fontWeight:900, color:editNetPreview()>=0?'var(--navy)':'#c62828' }}>{fmt(editNetPreview())}</span>
                  </div>
                  <div style={{ fontSize:11, color:'#888', textAlign:'center', marginBottom:10 }}>Saving will update the app and download a corrected invoice PDF.</div>
                  {load.status === 'paid' && (
                    <div style={{ marginBottom:10 }}>
                      <div style={{ fontSize:11, color:'#e65100', fontFamily:'var(--font-head)', fontWeight:700, textAlign:'center', marginBottom:6 }}>
                        {load.ach_payment ? '⚡ This load was marked ACH paid. Unpay to correct it.' : 'This load is marked paid. Unpay to correct it.'}
                      </div>
                      <button disabled={updating===loadId} onClick={async () => { await patchLoad(load, localIdx, { status:'billed', ach_payment:0, ach_received:0 }); closeEdit(); showToast('Load reset to billed — ready to re-pay') }} style={{ width:'100%', padding:'11px 0', borderRadius:8, border:'2px solid #e65100', background:'#fff3e0', color:'#e65100', fontFamily:'var(--font-head)', fontWeight:900, fontSize:13, cursor:'pointer', letterSpacing:'0.05em' }}>
                        {updating===loadId ? 'UPDATING...' : '↩️ MARK UNPAID — RESET TO BILLED'}
                      </button>
                    </div>
                  )}
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                    <button className="scan-btn secondary" style={{ padding:'10px', fontSize:13 }} onClick={closeEdit}>CANCEL</button>
                    <button className="scan-btn success" style={{ padding:'10px', fontSize:13 }} onClick={() => saveEdit(load,localIdx)}>SAVE + DOWNLOAD</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
