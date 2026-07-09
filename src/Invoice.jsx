// src/Invoice.jsx
// (c) dbappsystems.com | daddyboyapps.com
//
// AUTH MIGRATION: all 3 API calls (OCR, save load, upload PDF) now go through
// the token api() client. The `api` URL prop is gone.
//
// SCAN ROBUSTNESS (2026-06-20, v2):
//   The receipt scanner now mirrors the PROVEN RateCon flow:
//     1. OCR runs FIRST on the ORIGINAL file bytes (exactly like RateCon).
//        This is the step that extracts the amount, and it never depends on
//        PDF.js or the B&W canvas pipeline.
//     2. The B&W image build (processFile) runs AFTER, wrapped in its own
//        try/catch. If it fails (e.g. PDF.js still loading), the receipt is
//        STILL saved with the scanned amount — just without a thumbnail image.
//   Result: a scan can never be blocked by the image pipeline. If OCR returns
//   an amount, the scan succeeds. This is why RateCon always worked and the
//   receipt scanner did not — the old code ran processFile() BEFORE the OCR
//   call, so a PDF.js hiccup killed the scan before it ever reached the API.
//
//   sniffIsPdf() still decides PDF vs image by the file's real first bytes
//   ("%PDF-"), since iOS type/name are unreliable.
//
// BOL ROBUSTNESS (2026-06-26):
//   BOL adds used to call processFile(f) blindly — for a PDF that forced the
//   PDF.js path, and if PDF.js was blocked by CSP the WHOLE add threw and the
//   user got NOTHING. That is why lumpers/incidentals (OCR-first) worked while
//   BOLs never did. handleBOL now processes each file INDEPENDENTLY and, when
//   the B&W/PDF.js pipeline fails, falls back to embedding the file's own bytes
//   directly (rawImageFallback). A BOL can no longer be blocked by PDF.js. A
//   true PDF that cannot be rasterized is still attached as a raw page so the
//   document is never lost.
//
// MULTI-PAGE BOL PDF (2026-07-01):
//   Bruce reported a 16-page BOL PDF only capturing a couple of pages. Root
//   cause: renderPdfToCanvas rendered PAGE 1 ONLY, so a whole multi-page PDF
//   collapsed to a single BOL entry (or a single raw placeholder on fallback).
//   handleBOL now EXPANDS a PDF into one BOL per page via renderPdfAllPages,
//   respecting the 50-BOL cap, so a 16-page PDF becomes 16 BOL pages. The
//   receipt scanner still uses page 1 only, because a receipt is one page.
//
// SCAN CLARITY (2026-06-30, v3 — Sauvola + auto fallback):
//   BOL digits and dense black ink were merging into unreadable blobs. The
//   prior mean-only adaptive threshold floods the white gaps in dense ink.
//   Replaced with SAUVOLA binarization (the document-imaging reference method):
//   the local threshold uses local mean AND local standard deviation, so
//   uniform ink blocks keep the white gaps between characters. Reference
//   params: window 51, k=0.20, R=128. On top of that, an automatic QUALITY GATE
//   mirrors Transflo's documented rule — produce black & white only when it
//   does not sacrifice quality, otherwise fall back to clean grayscale. If the
//   B&W result is over-inked (>45% black, a blob) OR under-inked (<0.4% black,
//   a faint scan Sauvola dropped), the cleaned grayscale is returned instead,
//   so a BOL is ALWAYS readable. Input stays at 2000px.
//
// WHITE-LABEL (done): the generated invoice PDF carrier identity — company name,
// contact name, address, MC#/DOT#, contact line, signature, and the PDF filename
// — comes from the tenant's own settings (display_name, legal_name,
// remit_address, mc_number, dot_number, support_email, slug from migration 0002),
// resolved from the session token by the worker. Fallbacks are NEUTRAL/blank.
//
// D1 PAYLOAD SIZE (2026-07-08):
//   Bruce hit "String or blob too big" saving a load with scanned lumper/
//   incidental/comdata receipts. Root cause: the POST /api/loads body sent the
//   FULL line-item objects, each carrying dataUrl + base64 (the receipt image
//   as a data URI). The worker JSON.stringifies those arrays into single D1
//   TEXT columns (loads.lumpers/incidentals/comdatas), and a few receipt images
//   overflow D1's ~1MB per-value cap. BOLs never tripped this because only
//   bol_count (a number) is sent. Fix: stripImg() removes dataUrl/base64 from
//   each line item in the DB payload ONLY. The images stay in component state,
//   so the PDF build and R2 upload below are unchanged — receipts still render
//   and upload exactly as before. D1 keeps amount/label/w/h so reloaded load
//   cards still show the lines.

import { useState, useRef } from 'react'
import { jsPDF } from 'jspdf'
import { api as apiClient } from './api.js'

const MAX_BOLS = 50

export default function Invoice({ load, setLoad, driver, showToast, fetchLoads, resetLoad, tenantSettings }) {
  const [scanning,   setScanning]   = useState(null)
  const [bolLoading, setBolLoading] = useState(false)

  const [showManualLumper,     setShowManualLumper]     = useState(false)
  const [showManualIncidental, setShowManualIncidental] = useState(false)
  const [showManualComdata,    setShowManualComdata]    = useState(false)
  const [manualLumper,         setManualLumper]         = useState('')
  const [manualIncidental,     setManualIncidental]     = useState('')
  const [manualComdata,        setManualComdata]        = useState('')

  const fileRef  = useRef()
  const bolRef   = useRef()
  const scanMode = useRef(null)

  const base_pay     = parseFloat(load.base_pay)     || 0
  const detention    = parseFloat(load.detention)    || 0
  const pallets      = parseFloat(load.pallets)      || 0
  const lumperTotal  = load.lumpers.reduce((s,i)     => s + parseFloat(i.amount||0), 0)
  const incTotal     = load.incidentals.reduce((s,i) => s + parseFloat(i.amount||0), 0)
  const comdataTotal = load.comdatas.reduce((s,i)    => s + parseFloat(i.amount||0), 0)
  const subtotal     = base_pay + lumperTotal + incTotal + detention + pallets
  const netPay       = subtotal - comdataTotal

  // ── WHITE-LABEL CARRIER IDENTITY ─────────────────────────
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
  const filePrefix    = (ts.slug && ts.slug.trim()) ? ts.slug.trim() : 'Invoice'

  function fmt(n) { return '$' + n.toFixed(2) }
  function openScanner(mode) { scanMode.current = mode; fileRef.current.click() }

  // Detect a PDF by its actual bytes, not by the OS-supplied type/name (both
  // unreliable on iOS). A real PDF begins with the ASCII signature "%PDF-".
  // Anything else — including every photo — is treated as an image.
  async function sniffIsPdf(file) {
    try {
      const head = await file.slice(0, 5).arrayBuffer()
      const b = new Uint8Array(head)
      // 0x25 0x50 0x44 0x46 0x2D === "%PDF-"
      return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2D
    } catch {
      return false  // if we can't read the header, assume image (safer path)
    }
  }

  // Wait briefly for the PDF.js script before giving up (only used for true PDFs).
  async function waitForPdfJs(maxMs = 4000) {
    if (window.pdfjsLib) return window.pdfjsLib
    const step = 150
    let waited = 0
    while (waited < maxMs) {
      await new Promise(r => setTimeout(r, step))
      waited += step
      if (window.pdfjsLib) {
        if (window.__configurePdfJs) window.__configurePdfJs()
        return window.pdfjsLib
      }
    }
    return null
  }

  // ── MANUAL ADD HANDLERS ──────────────────────────────────
  function addManualLumper() {
    const val = parseFloat(manualLumper)
    if (!val || val <= 0) { showToast('Enter a valid amount'); return }
    setLoad(p => ({ ...p, lumpers: [...p.lumpers, { amount: val.toFixed(2), label: 'Manual entry', dataUrl: null, base64: null, w: 0, h: 0 }] }))
    setManualLumper('')
    showToast('✅ Lumper added: $' + val.toFixed(2))
  }

  function addManualIncidental() {
    const val = parseFloat(manualIncidental)
    if (!val || val <= 0) { showToast('Enter a valid amount'); return }
    setLoad(p => ({ ...p, incidentals: [...p.incidentals, { amount: val.toFixed(2), label: 'Manual entry', dataUrl: null, base64: null, w: 0, h: 0 }] }))
    setManualIncidental('')
    showToast('✅ Incidental added: $' + val.toFixed(2))
  }

  function addManualComdata() {
    const val = parseFloat(manualComdata)
    if (!val || val <= 0) { showToast('Enter a valid amount'); return }
    setLoad(p => ({ ...p, comdatas: [...p.comdatas, { amount: val.toFixed(2), label: 'Manual entry', dataUrl: null, base64: null, w: 0, h: 0 }] }))
    setManualComdata('')
    showToast('✅ Comdata added: -$' + val.toFixed(2))
  }

  // ── RENDER ONE PDF PAGE OBJECT TO CANVAS ─────────────────
  // Rasterize an already-opened PDF page into a fresh canvas at up to 2000px.
  async function renderPdfPageToCanvas(page) {
    const MAX      = 2000
    const baseVP   = page.getViewport({ scale: 1 })
    const scale    = Math.min(MAX / baseVP.width, MAX / baseVP.height, 3.0)
    const viewport = page.getViewport({ scale })
    const canvas   = document.createElement('canvas')
    canvas.width   = Math.round(viewport.width)
    canvas.height  = Math.round(viewport.height)
    const ctx      = canvas.getContext('2d')
    await page.render({ canvasContext: ctx, viewport }).promise
    return canvas
  }

  // ── RENDER PDF PAGE 1 TO CANVAS ──────────────────────────
  // Used by the RECEIPT scanner, where a receipt is a single page.
  async function renderPdfToCanvas(file) {
    const pdfjsLib = await waitForPdfJs()
    if (!pdfjsLib) throw new Error('PDF reader still loading — try again, or use a photo of the page')
    const arrayBuf = await file.arrayBuffer()
    const pdf      = await pdfjsLib.getDocument({ data: arrayBuf }).promise
    const page     = await pdf.getPage(1)
    return await renderPdfPageToCanvas(page)
  }

  // ── RENDER EVERY PDF PAGE TO ITS OWN CANVAS ──────────────
  // (2026-07-01) Multi-page BOL PDFs must produce one BOL per page. Opens the
  // PDF once and rasterizes each page 1..numPages into its own canvas.
  async function renderPdfAllPages(file) {
    const pdfjsLib = await waitForPdfJs()
    if (!pdfjsLib) throw new Error('PDF reader still loading — try again, or use a photo of the page')
    const arrayBuf = await file.arrayBuffer()
    const pdf      = await pdfjsLib.getDocument({ data: arrayBuf }).promise
    const canvases = []
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n)
      canvases.push(await renderPdfPageToCanvas(page))
    }
    return canvases
  }

  // ── SCAN PIPELINE — INDUSTRY-STANDARD SAUVOLA + AUTO FALLBACK ───
  // (2026-06-30, v3) Bruce reported BOL digits and dense black ink merging into
  // unreadable blobs. The earlier Bradley-Roth threshold used only the local
  // MEAN, so in a dense block of ink the local mean drops and the white gaps
  // between digits get flooded solid.
  //
  // Replaced with SAUVOLA — the widely-adopted reference method for document
  // binarization. Sauvola factors in the local standard deviation as well as
  // the mean: T(x,y) = mean * (1 + k * (stdDev / R - 1)). In a uniform ink
  // block the local stdDev is low, which RAISES the local threshold and keeps
  // the thin white gaps between characters open. Reference parameters are used
  // verbatim: window 51, k = 0.20, R = 128.
  //
  // On top of that, an automatic QUALITY GATE mirrors Transflo's documented
  // rule ("use black & white only if it does not sacrifice quality, otherwise
  // fall back to grayscale"). After binarizing we measure the black-pixel
  // fraction. A clean document page is a small percentage black. If the B&W
  // result comes out heavily over-inked (a blobbed page), we DISCARD it and
  // return a cleaned GRAYSCALE image instead — always readable, never a blob.
  //
  // helpers used by both paths:
  //   toGrayContrastSharp(canvas) -> { gray, w, h } cleaned grayscale buffer
  //   integralImage(buf, w, h)    -> integral + integral-of-squares (for stdDev)

  // Cleaned grayscale: luma -> contrast stretch -> light unsharp mask.
  // This is the readable fallback AND the input to Sauvola.
  function toGrayContrastSharp(canvas) {
    const w   = canvas.width
    const h   = canvas.height
    const ctx = canvas.getContext('2d')
    const id  = ctx.getImageData(0, 0, w, h)
    const d   = id.data

    const gray = new Uint8ClampedArray(w * h)
    for (let i = 0; i < gray.length; i++) {
      const p = i * 4
      gray[i] = Math.round(0.299 * d[p] + 0.587 * d[p+1] + 0.114 * d[p+2])
    }

    // contrast stretch
    let mn = 255, mx = 0
    for (let i = 0; i < gray.length; i++) {
      if (gray[i] < mn) mn = gray[i]
      if (gray[i] > mx) mx = gray[i]
    }
    const range = mx - mn || 1
    for (let i = 0; i < gray.length; i++) {
      gray[i] = Math.round(((gray[i] - mn) / range) * 255)
    }

    // light unsharp mask (3x3 gaussian) to crisp the strokes
    const kernel = [1,2,1, 2,4,2, 1,2,1]
    const blurred = new Uint8ClampedArray(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, ki = 0
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const nx = Math.min(Math.max(x + kx, 0), w - 1)
            const ny = Math.min(Math.max(y + ky, 0), h - 1)
            sum += gray[ny * w + nx] * kernel[ki++]
          }
        }
        blurred[y * w + x] = Math.round(sum / 16)
      }
    }
    const sharp = new Uint8ClampedArray(w * h)
    const amount = 0.8
    for (let i = 0; i < sharp.length; i++) {
      const v = Math.round(gray[i] + amount * (gray[i] - blurred[i]))
      sharp[i] = v < 0 ? 0 : (v > 255 ? 255 : v)
    }
    return { gray: sharp, w, h, ctx, id, data: d }
  }

  // Render a grayscale buffer back to the canvas and export JPEG.
  function exportGray(canvas, gray, w, h, ctx, id, data, quality) {
    for (let i = 0; i < gray.length; i++) {
      const p = i * 4
      data[p] = data[p+1] = data[p+2] = gray[i]
      data[p+3] = 255
    }
    ctx.putImageData(id, 0, 0)
    const dataUrl = canvas.toDataURL('image/jpeg', quality)
    return { dataUrl, base64: dataUrl.split(',')[1], w, h }
  }

  // ── PRIMARY: SAUVOLA BINARIZATION WITH GRAYSCALE FALLBACK ──
  function applyBWPipeline(canvas) {
    const { gray, w, h, ctx, id, data } = toGrayContrastSharp(canvas)

    // Sauvola needs local mean and local stdDev over a window. Build the
    // integral image (sum) and the integral image of squares (sumSq) so each
    // window is O(1). Use Float64 for sumSq to avoid overflow on 2000px scans.
    const integ   = new Float64Array(w * h)
    const integSq = new Float64Array(w * h)
    for (let y = 0; y < h; y++) {
      let rowSum = 0, rowSumSq = 0
      for (let x = 0; x < w; x++) {
        const v = gray[y * w + x]
        rowSum   += v
        rowSumSq += v * v
        const up   = y > 0 ? integ[(y-1)*w+x]   : 0
        const upSq = y > 0 ? integSq[(y-1)*w+x] : 0
        integ[y*w+x]   = rowSum   + up
        integSq[y*w+x] = rowSumSq + upSq
      }
    }

    // Reference Sauvola parameters (document-imaging standard).
    const WIN = 51                 // window size
    const k   = 0.20               // Sauvola k constant
    const R   = 128                // dynamic range of stdDev
    const rad = Math.floor(WIN / 2)

    const out = new Uint8ClampedArray(w * h)
    let blackCount = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const x1 = Math.max(x - rad, 0)
        const y1 = Math.max(y - rad, 0)
        const x2 = Math.min(x + rad, w - 1)
        const y2 = Math.min(y + rad, h - 1)
        const area = (x2 - x1 + 1) * (y2 - y1 + 1)

        const A  = (x1 > 0 && y1 > 0) ? integ[(y1-1)*w+(x1-1)] : 0
        const B  = (y1 > 0)           ? integ[(y1-1)*w+x2]     : 0
        const C  = (x1 > 0)           ? integ[y2*w+(x1-1)]     : 0
        const Dt = integ[y2*w+x2]
        const sum = Dt - B - C + A

        const Asq  = (x1 > 0 && y1 > 0) ? integSq[(y1-1)*w+(x1-1)] : 0
        const Bsq  = (y1 > 0)           ? integSq[(y1-1)*w+x2]     : 0
        const Csq  = (x1 > 0)           ? integSq[y2*w+(x1-1)]     : 0
        const Dsq  = integSq[y2*w+x2]
        const sumSq = Dsq - Bsq - Csq + Asq

        const mean = sum / area
        let variance = (sumSq / area) - (mean * mean)
        if (variance < 0) variance = 0
        const stdDev = Math.sqrt(variance)

        // Sauvola threshold
        const t = mean * (1 + k * (stdDev / R - 1))
        const px = gray[y * w + x] <= t ? 0 : 255
        out[y * w + x] = px
        if (px === 0) blackCount++
      }
    }

    // ── QUALITY GATE (Transflo rule, both directions) ──
    // A clean text page is a SMALL but non-zero fraction black. Two B&W failure
    // modes both fall back to clean grayscale so the document is ALWAYS legible:
    //   • OVER-inked (>45% black): a blobbed page — the merging Bruce reported.
    //   • UNDER-inked (<0.4% black): faint/low-contrast scan where Sauvola
    //     dropped the text. Grayscale keeps the faint text visible.
    // Normal BOLs land well inside this band and keep the crisp B&W.
    const blackFrac = blackCount / (w * h)
    if (blackFrac > 0.45 || blackFrac < 0.004) {
      // fallback: return the cleaned grayscale instead of a blobbed or blank B&W
      return exportGray(canvas, gray, w, h, ctx, id, data, 0.92)
    }

    // good B&W: write binary back and export
    for (let i = 0; i < out.length; i++) {
      const p = i * 4
      data[p] = data[p+1] = data[p+2] = out[i]
      data[p+3] = 255
    }
    ctx.putImageData(id, 0, 0)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.95)
    return { dataUrl, base64: dataUrl.split(',')[1], w, h }
  }

  // ── IMAGE FILE -> CANVAS (shared) ────────────────────────
  function imageFileToCanvas(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('Could not read the image file'))
      reader.onload = (ev) => {
        const img = new Image()
        img.onerror = () => reject(new Error('Could not decode the image'))
        img.onload = () => {
          const MAX = 2000
          let w = img.naturalWidth  || img.width  || 800
          let h = img.naturalHeight || img.height || 1000
          if (w > MAX) { h = Math.round(h * MAX / w); w = MAX }
          if (h > MAX) { w = Math.round(w * MAX / h); h = MAX }
          const c  = document.createElement('canvas')
          c.width  = w
          c.height = h
          c.getContext('2d').drawImage(img, 0, 0, w, h)
          resolve(c)
        }
        img.src = ev.target.result
      }
      reader.readAsDataURL(file)
    })
  }

  // ── PROCESS ANY FILE — image OR pdf (decided by byte signature) ──
  // For a PDF this uses PAGE 1 only (receipt scanner path). BOL multi-page
  // expansion is handled separately in handleBOL via processFileAllPages.
  async function processFile(file, isPdfHint) {
    const isPdf = (typeof isPdfHint === 'boolean') ? isPdfHint : await sniffIsPdf(file)
    let canvas
    if (isPdf) {
      canvas = await renderPdfToCanvas(file)
    } else {
      canvas = await imageFileToCanvas(file)
    }
    const result = applyBWPipeline(canvas)
    return { ...result, name: file.name }
  }

  // ── PROCESS EVERY PAGE OF A FILE ─────────────────────────
  // (2026-07-01) Returns an ARRAY of processed pages. A PDF yields one entry
  // per page; an image yields a single entry. Used by the BOL path so a
  // multi-page PDF becomes multiple BOLs.
  async function processFileAllPages(file, isPdf) {
    if (isPdf) {
      const canvases = await renderPdfAllPages(file)
      const total = canvases.length
      return canvases.map((canvas, idx) => {
        const result = applyBWPipeline(canvas)
        const pageName = total > 1
          ? file.name + ' (p' + (idx + 1) + '/' + total + ')'
          : file.name
        return { ...result, name: pageName }
      })
    }
    const canvas = await imageFileToCanvas(file)
    const result = applyBWPipeline(canvas)
    return [{ ...result, name: file.name }]
  }

  // ── RAW IMAGE FALLBACK — never lose a BOL ────────────────
  // Used when the B&W / PDF.js pipeline fails (e.g. PDF.js blocked by CSP, or a
  // PDF that cannot be rasterized on-device). For an IMAGE we embed the photo as
  // it is (no B&W cleanup, but the BOL is captured). For a PDF that cannot be
  // rendered, we cannot turn it into an <img>, so we attach a lightweight
  // placeholder page that names the file — the load is still recorded with the
  // correct BOL count and the driver is told to add a photo of the page.
  async function rawImageFallback(file, isPdf) {
    if (isPdf) {
      // Cannot rasterize the PDF on this device. Capture it as a named
      // placeholder so the BOL is not silently dropped.
      return {
        dataUrl: null,
        base64:  null,
        w: 0,
        h: 0,
        name: file.name,
        placeholder: true,
      }
    }
    // Image: embed the original photo bytes directly, scaled to a sane max.
    return await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('Could not read the image file'))
      reader.onload = (ev) => {
        const img = new Image()
        img.onerror = () => reject(new Error('Could not decode the image'))
        img.onload = () => {
          const MAX = 1400
          let w = img.naturalWidth  || img.width  || 800
          let h = img.naturalHeight || img.height || 1000
          if (w > MAX) { h = Math.round(h * MAX / w); w = MAX }
          if (h > MAX) { w = Math.round(w * MAX / h); h = MAX }
          const c  = document.createElement('canvas')
          c.width  = w
          c.height = h
          c.getContext('2d').drawImage(img, 0, 0, w, h)
          const dataUrl = c.toDataURL('image/jpeg', 0.9)
          resolve({ dataUrl, base64: dataUrl.split(',')[1], w, h, name: file.name })
        }
        img.src = ev.target.result
      }
      reader.readAsDataURL(file)
    })
  }

  // ── BOL UPLOAD ───────────────────────────────────────────
  // ROBUST + MULTI-PAGE: each file is processed INDEPENDENTLY. A PDF is expanded
  // to ONE BOL PER PAGE (processFileAllPages) so a 16-page PDF becomes 16 BOLs.
  // The 50-BOL cap is enforced across the expanded pages. If the B&W/PDF.js
  // pipeline throws for a file — most commonly a PDF when PDF.js is blocked by
  // CSP — we fall back to rawImageFallback so the BOL is STILL added. One bad
  // file can never block the rest.
  async function handleBOL(e) {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    let remaining = MAX_BOLS - load.bols.length
    if (remaining <= 0) { showToast('Max 50 BOLs reached'); return }
    setBolLoading(true)
    showToast('📷 Processing BOL scans...')

    const processed = []
    let cleaned = 0, raw = 0, placeheld = 0, failed = 0, capped = 0

    for (const f of files) {
      if (remaining <= 0) { capped++; continue }
      const isPdf = await sniffIsPdf(f)
      try {
        // Expand PDFs to one page each; images return a single-element array.
        const pages = await processFileAllPages(f, isPdf)
        for (const page of pages) {
          if (remaining <= 0) { capped++; continue }
          processed.push(page)
          cleaned++
          remaining--
        }
      } catch (errPrimary) {
        // Pipeline failed (PDF.js blocked, decode error, etc). Fall back so the
        // BOL is never lost.
        try {
          const fb = await rawImageFallback(f, isPdf)
          processed.push(fb)
          remaining--
          if (fb.placeholder) placeheld++; else raw++
        } catch (errFb) {
          failed++
          console.error('BOL fallback failed for', f.name, errFb)
        }
      }
    }

    if (processed.length) {
      setLoad(p => ({ ...p, bols: [...p.bols, ...processed] }))
    }

    // Honest, specific status — name what happened, no generic failure.
    const parts = []
    if (cleaned)   parts.push(cleaned + ' added')
    if (raw)       parts.push(raw + ' added (original photo)')
    if (placeheld) parts.push(placeheld + ' PDF noted — add a photo of the page')
    if (capped)    parts.push(capped + ' skipped (50 max)')
    if (failed)    parts.push(failed + ' failed')
    if (processed.length) {
      showToast('✅ BOL: ' + parts.join(', '))
    } else {
      showToast('❌ BOL add failed: ' + (failed + ' file(s) could not be read'))
    }

    setBolLoading(false)
    e.target.value = ''
  }

  function removeBOL(idx) {
    setLoad(p => ({ ...p, bols: p.bols.filter((_,i) => i !== idx) }))
  }

  // ── RECEIPT SCANNER ──────────────────────────────────────
  // PROVEN FLOW (mirrors RateCon, which always worked):
  //   1) OCR the ORIGINAL file bytes first — this is what gets the amount and
  //      it never touches PDF.js / the B&W pipeline.
  //   2) Build the B&W receipt image SEPARATELY and NON-BLOCKINGLY. If that
  //      step fails, we still save the receipt with its amount, just with no
  //      thumbnail. The scan can never be killed by the image pipeline again.
  async function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    const mode = scanMode.current
    setScanning(mode)
    showToast('📡 Scanning receipt...')
    try {
      // Decide PDF vs image ONCE, by bytes.
      const isPdf     = await sniffIsPdf(file)
      const mediaType = isPdf ? 'application/pdf' : (file.type || 'image/jpeg')

      // ── STEP 1: OCR FIRST (exactly like RateCon) ──────────
      const base64 = await toBase64(file)
      const json   = await apiClient('/api/ocr', {
        method: 'POST',
        json:   { base64, mediaType, mode },
      })
      // api() throws on any non-200 with the real reason in err.message/err.detail.
      if (json && json.error) throw new Error(json.detail || json.error)

      let raw = json.result || ''
      raw = raw.replace(/```json/gi,'').replace(/```/gi,'').trim()
      const start = raw.indexOf('{')
      const end   = raw.lastIndexOf('}')
      if (start === -1 || end === -1) throw new Error('Document read OK but no amount found — add it manually')

      const parsed = JSON.parse(raw.substring(start, end + 1))
      const amount = parsed.amount || '0.00'

      // ── STEP 2: BUILD RECEIPT IMAGE — NON-BLOCKING ────────
      // The amount is already secured. Image processing is a nice-to-have for
      // the attached receipt page; if it fails, save the amount anyway.
      let img = { dataUrl: null, base64: null, w: 0, h: 0 }
      try {
        const scanned = await processFile(file, isPdf)
        img = { dataUrl: scanned.dataUrl, base64: scanned.base64, w: scanned.w, h: scanned.h }
      } catch (imgErr) {
        console.error('Receipt image processing failed (amount still saved):', imgErr)
        showToast('⚠️ Amount captured — receipt image skipped')
      }

      const item = { amount, label: file.name, dataUrl: img.dataUrl, base64: img.base64, w: img.w, h: img.h }

      if (mode === 'lumper')     setLoad(p => ({ ...p, lumpers:     [...p.lumpers,     item] }))
      if (mode === 'incidental') setLoad(p => ({ ...p, incidentals: [...p.incidentals, item] }))
      if (mode === 'express')    setLoad(p => ({ ...p, comdatas:    [...p.comdatas,    item] }))
      showToast('✅ Receipt scanned! $' + amount)
    } catch (err) {
      const reason = (err && (err.detail || err.message))
        ? String(err.detail || err.message).slice(0, 110)
        : 'unknown error'
      showToast('❌ ' + reason)
      console.error('OCR scan error:', err)
    } finally {
      setScanning(null)
      e.target.value = ''
    }
  }

  function removeItem(type, idx) {
    setLoad(p => ({ ...p, [type]: p[type].filter((_,i) => i !== idx) }))
  }

  function toBase64(file) {
    return new Promise((res, rej) => {
      const r = new FileReader()
      r.onload  = () => res(r.result.split(',')[1])
      r.onerror = rej
      r.readAsDataURL(file)
    })
  }

  // ── ADD SCAN PAGE TO PDF ─────────────────────────────────
  function addScanPage(doc, item, label) {
    // A placeholder BOL (PDF that could not be rasterized) has no image. Still
    // add a named page so the document records that a BOL exists for this load.
    if (!item.dataUrl || !item.w || !item.h) {
      if (item && item.placeholder) {
        try {
          doc.addPage()
          const pageW = 612, pageH = 792
          doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.setTextColor(0,0,0)
          doc.text(label, pageW / 2, pageH / 2 - 10, { align: 'center' })
          doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(120,120,120)
          doc.text('Original BOL on file: ' + (item.name || 'PDF'), pageW / 2, pageH / 2 + 10, { align: 'center' })
          doc.text('A photo of this BOL page can be added from the load.', pageW / 2, pageH / 2 + 26, { align: 'center' })
        } catch (err) { console.error('placeholder page error:', err) }
      }
      return
    }
    try {
      doc.addPage()
      const pageW = 612, pageH = 792, pad = 30
      const ratio = Math.min((pageW - pad * 2) / item.w, (pageH - pad * 2) / item.h)
      const imgW  = Math.round(item.w * ratio)
      const imgH  = Math.round(item.h * ratio)
      const x     = Math.round((pageW - imgW) / 2)
      const yPos  = Math.round((pageH - imgH) / 2)
      doc.addImage(item.dataUrl, 'JPEG', x, yPos, imgW, imgH)
      doc.setFontSize(7)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(160, 160, 160)
      doc.text(label, pageW / 2, 787, { align: 'center' })
    } catch (err) { console.error('addScanPage error:', err) }
  }

  // ── GENERATE PDF + SAVE TO D1 + UPLOAD TO R2 ─────────────
  // PROVEN ORDER: 1) D1 save  2) Build PDF  3) R2 upload  4) doc.save() download
  // doc.save() must fire LAST — it triggers the phone download
  // which if fired early causes subsequent fetches to be dropped

  // D1 stores line-item METADATA only — never the receipt image bytes.
  // dataUrl/base64 ride into the PDF (built below) and up to R2, exactly like
  // BOLs (which send only a count). Sending the image strings to D1 overflows
  // its ~1MB per-value cap ("String or blob too big"). stripImg removes them
  // from the DB payload ONLY; component state keeps the images for the PDF.
  const stripImg = ({ dataUrl, base64, ...keep }) => keep

  async function generatePDF() {

    // ── STEP 1: SAVE TO D1 FIRST ─────────────────────────
    showToast('💾 Saving load...')
    let savedLoadId = null
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
          base_pay:         base_pay,
          lumper_total:     lumperTotal,
          incidental_total: incTotal,
          comdata_total:    comdataTotal,
          detention:        detention,
          pallets:          pallets,
          net_pay:          netPay,
          notes:            load.notes         || '',
          bol_count:        load.bols.length,
          lumpers:          load.lumpers.map(stripImg),
          incidentals:      load.incidentals.map(stripImg),
          comdatas:         load.comdatas.map(stripImg),
          status:           'invoiced',
        },
      })
      savedLoadId = data.id
    } catch (err) {
      showToast('⚠️ Save failed: ' + err.message)
      return
    }

    // ── STEP 1b: SAVE STOPS + FIRE IFTA ROUTING ──────────
    // The rate con scan (RateCon.jsx) carries every pickup and delivery on
    // load.stops in run order: { type, address, city, state, zip, date }.
    // Each becomes a load_stops row (the Worker geocodes on save), then
    // POST /api/loads/{id}/route-ifta routes the stops over real highways
    // and writes this load's per-state ifta_miles — including the deadhead
    // leg from the prior load's last drop.
    //
    // NON-BLOCKING BY DESIGN: the invoice is already saved. Nothing in this
    // step is allowed to stop the PDF from building — any failure here logs,
    // toasts once, and the flow continues. route-ifta is idempotent, so a
    // missed run can always be re-fired later without duplicating miles.
    try {
      let stopRows = Array.isArray(load.stops) ? load.stops : []
      if (!stopRows.length) {
        // Manual-entry fallback (no RC scan): derive a two-stop run from the
        // typed origin/destination. The Worker geocoder takes the full
        // free-text string in the city field ("Dallas, TX" geocodes fine).
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
              load_id:   savedLoadId,
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
        // Fire-and-forget: routing calls external services and can take a few
        // seconds. The IFTA card refreshes from the ledger whenever opened.
        apiClient('/api/loads/' + savedLoadId + '/route-ifta', { method: 'POST' })
          .catch(err => console.error('route-ifta error:', err))
      }
    } catch (err) {
      console.error('load-stop save error:', err)
      showToast('⚠️ IFTA stops skipped: ' + (err.message || '').slice(0, 50))
    }

    // ── STEP 2: BUILD PDF IN MEMORY ───────────────────────
    const doc = new jsPDF({ unit: 'pt', format: 'letter' })
    const W = 612, M = 40
    let y = 0

    doc.setFontSize(22); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    doc.text(coName, W/2, 50, { align:'center' })
    doc.setDrawColor(180,180,180); doc.setLineWidth(0.5); doc.line(M, 58, W-M, 58)
    y = 75

    doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    doc.text(coLegalName, M, y)
    doc.setFont('helvetica','normal')
    doc.text(coAddress, M, y+12)
    const idLine = coDot ? (coMc + '  ' + coDot) : coMc
    doc.text(idLine, M, y+24)
    doc.text(coContactLine, M, y+36)
    doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(100,100,100)
    doc.text('DATE SENT', W-M, y, { align:'right' })
    doc.setDrawColor(180,180,180); doc.line(W-160, y+3, W-M, y+3)
    doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    doc.text(new Date().toLocaleDateString('en-US'), W-M, y+16, { align:'right' })

    y += 60; doc.setDrawColor(180,180,180); doc.line(M, y, W-M, y); y += 14

    doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(100,100,100)
    doc.text('BILL TO', M, y); doc.text('LOAD #', W/2, y); y += 12
    doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    const brokerLines = doc.splitTextToSize(load.broker_name || '-', 220)
    doc.text(brokerLines, M, y); doc.text(load.load_number || '-', W/2, y)
    y += brokerLines.length * 14 + 6
    doc.setDrawColor(180,180,180); doc.line(M, y, W-M, y); y += 14

    doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(100,100,100)
    doc.text('PICK UP LOCATION', M, y); doc.text('DELIVERY LOCATION', W/2, y); y += 12
    doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    const originLines = doc.splitTextToSize(load.origin || '-', 220)
    const destLines   = doc.splitTextToSize(load.destination || '-', 220)
    doc.text(originLines, M, y); doc.text(destLines, W/2, y)
    y += Math.max(originLines.length, destLines.length) * 14 + 6
    doc.setDrawColor(180,180,180); doc.line(M, y, W-M, y); y += 14

    doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(100,100,100)
    doc.text('DELIVERY DATE', M, y); y += 12
    doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    doc.text(load.delivery_date || '-', M, y)
    y += 20; doc.setDrawColor(180,180,180); doc.line(M, y, W-M, y); y += 18

    doc.setFontSize(9); doc.setFont('helvetica','italic'); doc.setTextColor(80,80,80)
    doc.text('Please remit payment amount for transport services', M, y); y += 20

    function lineItem(label, amount, bold, red) {
      doc.setFontSize(10); doc.setFont('helvetica', bold ? 'bold' : 'normal')
      doc.setTextColor(red ? 180 : 0, 0, 0)
      doc.text(label, M, y); doc.text(amount, W-M, y, { align:'right' }); y += 18
    }

    lineItem('Trucking Rate', fmt(base_pay), false, false)
    load.lumpers.forEach((l,i)     => lineItem('Lumper Receipt '+(i+1), fmt(parseFloat(l.amount)), false, false))
    load.incidentals.forEach((l,i) => lineItem('Incidental '+(i+1),     fmt(parseFloat(l.amount)), false, false))
    if (detention > 0) lineItem('Detention', fmt(detention), false, false)
    if (pallets   > 0) lineItem('Pallets',   fmt(pallets),   false, false)

    y += 4; doc.setDrawColor(0,0,0); doc.setLineWidth(1); doc.line(M, y, W-M, y); y += 14
    doc.setFontSize(11); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0)
    doc.text('SUBTOTAL', M, y); doc.text(fmt(subtotal), W-M, y, { align:'right' }); y += 20
    doc.setLineWidth(0.5); doc.setDrawColor(180,180,180); doc.line(M, y, W-M, y); y += 14

    load.comdatas.forEach((c,i) => {
      lineItem('Comdata / Express Code '+(i+1), '-'+fmt(parseFloat(c.amount)), false, true)
    })

    y += 8
    doc.setFillColor(30,30,30); doc.rect(M, y, W-M*2, 28, 'F')
    doc.setFontSize(13); doc.setFont('helvetica','bold'); doc.setTextColor(255,255,255)
    doc.text('NET BILLABLE TOTAL', M+10, y+19)
    doc.text(fmt(netPay), W-M-10, y+19, { align:'right' }); y += 48

    if (load.notes) {
      doc.setFontSize(9); doc.setFont('helvetica','italic'); doc.setTextColor(80,80,80)
      const noteLines = doc.splitTextToSize(load.notes, W-M*2)
      doc.text(noteLines, M, y); y += noteLines.length * 12 + 10
    }

    const bolCount     = load.bols.length
    const lumperScans  = load.lumpers.filter(l => l.dataUrl && l.w && l.h)
    const incScans     = load.incidentals.filter(l => l.dataUrl && l.w && l.h)
    const comdataScans = load.comdatas.filter(l => l.dataUrl && l.w && l.h)
    const totalAttach  = bolCount + lumperScans.length + incScans.length + comdataScans.length

    if (totalAttach > 0) {
      y += 10
      doc.setFontSize(9); doc.setFont('helvetica','normal'); doc.setTextColor(80,80,80)
      const parts = []
      if (bolCount            > 0) parts.push(bolCount + ' BOL(s)')
      if (lumperScans.length  > 0) parts.push(lumperScans.length + ' Lumper receipt(s)')
      if (incScans.length     > 0) parts.push(incScans.length + ' Incidental receipt(s)')
      if (comdataScans.length > 0) parts.push(comdataScans.length + ' Comdata receipt(s)')
      doc.text('Attached: ' + parts.join(', ') + ' - see following pages', M, y); y += 20
    }

    y += 10
    doc.setFontSize(9); doc.setFont('helvetica','normal'); doc.setTextColor(80,80,80)
    doc.text('Thank You', W-M, y, { align:'right' }); y += 20
    doc.setFontSize(14); doc.setFont('helvetica','bolditalic'); doc.setTextColor(0,0,0)
    doc.text(coSignature, W-M, y, { align:'right' })
    doc.setFontSize(7); doc.setFont('helvetica','normal'); doc.setTextColor(160,160,160)
    doc.text('dbappsystems.com | daddyboyapps.com', W/2, 760, { align:'center' })

    load.bols.forEach((bol,i) =>
      addScanPage(doc, bol, 'BOL '+(i+1)+' of '+bolCount+' - '+(bol.name || '')))
    lumperScans.forEach((l,i) =>
      addScanPage(doc, l, 'Lumper Receipt '+(i+1)+' - $'+parseFloat(l.amount).toFixed(2)+' - '+l.label))
    incScans.forEach((l,i) =>
      addScanPage(doc, l, 'Incidental '+(i+1)+' - $'+parseFloat(l.amount).toFixed(2)+' - '+l.label))
    comdataScans.forEach((l,i) =>
      addScanPage(doc, l, 'Comdata / Express Code '+(i+1)+' - $'+parseFloat(l.amount).toFixed(2)+' - '+l.label))

    // ── STEP 3: UPLOAD PDF TO R2 BEFORE DOWNLOAD ─────────
    const filename = filePrefix+'-'+(load.load_number||'draft')+'-'+driver+'.pdf'
    try {
      const pdfBase64 = doc.output('datauristring').split(',')[1]
      await apiClient('/api/upload-pdf', {
        method: 'POST',
        json:   { base64: pdfBase64, loadId: savedLoadId, filename },
      })
    } catch (err) {
      console.error('R2 upload failed (non-fatal):', err)
    }

    // ── STEP 4: REFRESH LOADS LIST ────────────────────────
    try { await fetchLoads() } catch {}

    // ── STEP 5: DOWNLOAD TO PHONE — always last ───────────
    doc.save(filename)
    showToast('✅ Invoice saved + downloaded!')
  }

  // ── SHARED INLINE INPUT STYLES ───────────────────────────
  const inlineBox = {
    marginTop: 10, background: 'var(--navy)',
    border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px',
  }
  const inlineInput = {
    flex: 1, background: 'var(--navy3)', border: '1px solid var(--amber)',
    color: 'var(--white)', borderRadius: 8, padding: '12px 14px',
    fontSize: 22, fontFamily: 'var(--font-head)', fontWeight: 700,
    minWidth: 0, WebkitAppearance: 'none',
  }
  const inlineAdd = {
    padding: '12px 20px', borderRadius: 8, border: 'none',
    background: 'var(--amber)', color: 'var(--navy)',
    fontSize: 15, fontFamily: 'var(--font-head)', fontWeight: 900,
    cursor: 'pointer', flexShrink: 0,
  }

  return (
    <div>
      <input ref={fileRef} type="file" accept="application/pdf,image/*" style={{display:'none'}} onChange={handleFile} />
      <input ref={bolRef}  type="file" accept="application/pdf,image/*" multiple style={{display:'none'}} onChange={handleBOL} />

      {/* BOL SCANS */}
      <div className="card">
        <div className="section-title">
          BOL Scans
          <span style={{fontSize:11,fontWeight:400,marginLeft:8,color:'var(--grey)'}}>
            {load.bols.length} / {MAX_BOLS}
          </span>
        </div>
        {load.bols.map((bol,i) => (
          <div className="scanned-item" key={i}>
            {bol.dataUrl
              ? <img src={bol.dataUrl} alt={'BOL '+(i+1)}
                  style={{width:48,height:48,objectFit:'cover',borderRadius:6,border:'1px solid var(--border)'}} />
              : <div style={{width:48,height:48,borderRadius:6,border:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--navy3)',color:'var(--grey)',fontSize:9,fontWeight:700,textAlign:'center'}}>PDF</div>}
            <div style={{flex:1,marginLeft:10}}>
              <div className="item-label">BOL {i+1}</div>
              <div style={{fontSize:10,color:'var(--grey)',marginTop:2}}>
                {bol.name}{bol.placeholder ? ' — PDF on file, add a photo of the page' : ''}
              </div>
            </div>
            <button className="remove-btn" onClick={()=>removeBOL(i)}>x</button>
          </div>
        ))}
        {load.bols.length < MAX_BOLS && (
          <button className="scan-btn secondary" style={{marginTop:8,width:'100%'}}
            onClick={()=>bolRef.current.click()} disabled={bolLoading}>
            {bolLoading ? 'Processing...' : 'Add BOL'}
          </button>
        )}
        {load.bols.length >= MAX_BOLS && (
          <div style={{textAlign:'center',color:'var(--grey)',fontSize:12,marginTop:8}}>Max 50 BOLs reached</div>
        )}
      </div>

      {/* LUMPER RECEIPTS */}
      <div className="card">
        <div className="section-title">Lumper Receipts</div>
        {load.lumpers.map((l,i) => (
          <div className="scanned-item" key={i}>
            {l.dataUrl && <img src={l.dataUrl} alt={'Lumper '+(i+1)}
              style={{width:48,height:48,objectFit:'cover',borderRadius:6,border:'1px solid var(--border)'}} />}
            <div style={{flex:1,marginLeft:l.dataUrl?10:0}}>
              <div className="item-label">Lumper {i+1}</div>
              <div className="item-amount">{fmt(parseFloat(l.amount))}</div>
            </div>
            <button className="remove-btn" onClick={()=>removeItem('lumpers',i)}>x</button>
          </div>
        ))}
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginTop:8}}>
          <button className="scan-btn secondary" onClick={()=>openScanner('lumper')} disabled={scanning==='lumper'}>
            {scanning==='lumper' ? 'Scanning...' : 'Scan Lumper'}
          </button>
          <button className="scan-btn secondary" onClick={()=>setShowManualLumper(p=>!p)}>
            {showManualLumper ? 'Cancel' : 'Manual'}
          </button>
        </div>
        {showManualLumper && (
          <div style={inlineBox}>
            <div style={{fontSize:11,color:'var(--grey)',marginBottom:6,fontFamily:'var(--font-head)',letterSpacing:'0.06em'}}>ENTER LUMPER AMOUNT</div>
            <div style={{display:'flex',gap:8}}>
              <input type="text" inputMode="decimal" pattern="[0-9.]*" placeholder="0.00"
                value={manualLumper} onChange={e => setManualLumper(e.target.value)}
                style={inlineInput} autoFocus />
              <button onClick={addManualLumper} style={inlineAdd}>ADD</button>
            </div>
          </div>
        )}
      </div>

      {/* INCIDENTALS */}
      <div className="card">
        <div className="section-title">Incidentals</div>
        {load.incidentals.map((l,i) => (
          <div className="scanned-item" key={i}>
            {l.dataUrl && <img src={l.dataUrl} alt={'Incidental '+(i+1)}
              style={{width:48,height:48,objectFit:'cover',borderRadius:6,border:'1px solid var(--border)'}} />}
            <div style={{flex:1,marginLeft:l.dataUrl?10:0}}>
              <div className="item-label">Incidental {i+1}</div>
              <div className="item-amount">{fmt(parseFloat(l.amount))}</div>
            </div>
            <button className="remove-btn" onClick={()=>removeItem('incidentals',i)}>x</button>
          </div>
        ))}
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginTop:8}}>
          <button className="scan-btn secondary" onClick={()=>openScanner('incidental')} disabled={scanning==='incidental'}>
            {scanning==='incidental' ? 'Scanning...' : 'Scan Incidental'}
          </button>
          <button className="scan-btn secondary" onClick={()=>setShowManualIncidental(p=>!p)}>
            {showManualIncidental ? 'Cancel' : 'Manual'}
          </button>
        </div>
        {showManualIncidental && (
          <div style={inlineBox}>
            <div style={{fontSize:11,color:'var(--grey)',marginBottom:6,fontFamily:'var(--font-head)',letterSpacing:'0.06em'}}>ENTER INCIDENTAL AMOUNT</div>
            <div style={{display:'flex',gap:8}}>
              <input type="text" inputMode="decimal" pattern="[0-9.]*" placeholder="0.00"
                value={manualIncidental} onChange={e => setManualIncidental(e.target.value)}
                style={inlineInput} autoFocus />
              <button onClick={addManualIncidental} style={inlineAdd}>ADD</button>
            </div>
          </div>
        )}
      </div>

      {/* DETENTION AND PALLETS */}
      <div className="card">
        <div className="section-title">Detention and Pallets</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div className="field-row">
            <div className="field-label">Detention ($)</div>
            <input value={load.detention} onChange={e=>setLoad(p=>({...p,detention:e.target.value}))} placeholder="0.00" type="number" inputMode="decimal" />
          </div>
          <div className="field-row">
            <div className="field-label">Pallets ($)</div>
            <input value={load.pallets} onChange={e=>setLoad(p=>({...p,pallets:e.target.value}))} placeholder="0.00" type="number" inputMode="decimal" />
          </div>
        </div>
      </div>

      {/* COMDATA */}
      <div className="card">
        <div className="section-title">Comdata / Express Codes</div>
        {load.comdatas.map((l,i) => (
          <div className="scanned-item" key={i}>
            {l.dataUrl && <img src={l.dataUrl} alt={'Comdata '+(i+1)}
              style={{width:48,height:48,objectFit:'cover',borderRadius:6,border:'1px solid var(--border)'}} />}
            <div style={{flex:1,marginLeft:l.dataUrl?10:0}}>
              <div className="item-label">Comdata {i+1}</div>
              <div className="item-amount red">-{fmt(parseFloat(l.amount))}</div>
            </div>
            <button className="remove-btn" onClick={()=>removeItem('comdatas',i)}>x</button>
          </div>
        ))}
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginTop:8}}>
          <button className="scan-btn danger" onClick={()=>openScanner('express')} disabled={scanning==='express'}>
            {scanning==='express' ? 'Scanning...' : 'Scan Comdata'}
          </button>
          <button className="scan-btn danger" onClick={()=>setShowManualComdata(p=>!p)}>
            {showManualComdata ? 'Cancel' : 'Manual'}
          </button>
        </div>
        {showManualComdata && (
          <div style={inlineBox}>
            <div style={{fontSize:11,color:'var(--grey)',marginBottom:6,fontFamily:'var(--font-head)',letterSpacing:'0.06em'}}>ENTER COMDATA AMOUNT</div>
            <div style={{display:'flex',gap:8}}>
              <input type="text" inputMode="decimal" pattern="[0-9.]*" placeholder="0.00"
                value={manualComdata} onChange={e => setManualComdata(e.target.value)}
                style={inlineInput} autoFocus />
              <button onClick={addManualComdata} style={inlineAdd}>ADD</button>
            </div>
          </div>
        )}
      </div>

      {/* NOTES */}
      <div className="card">
        <div className="section-title">Notes</div>
        <textarea
          value={load.notes || ''}
          onChange={e=>setLoad(p=>({...p,notes:e.target.value}))}
          placeholder="Special instructions, reference numbers, commodity..."
          style={{width:'100%',minHeight:70,background:'var(--navy3)',border:'1px solid var(--border)',color:'var(--white)',borderRadius:8,padding:'10px 12px',fontSize:14,fontFamily:'var(--font-body)',resize:'vertical'}}
        />
      </div>

      {/* BILLING SUMMARY */}
      <div className="card">
        <div className="section-title">Billing Summary</div>
        <div className="amount-row"><span className="label">Trucking Rate</span><span className="value">{fmt(base_pay)}</span></div>
        <div className="amount-row"><span className="label">Lumper Fees</span><span className="value">{fmt(lumperTotal)}</span></div>
        <div className="amount-row"><span className="label">Incidentals</span><span className="value">{fmt(incTotal)}</span></div>
        <div className="amount-row"><span className="label">Detention</span><span className="value">{fmt(detention)}</span></div>
        <div className="amount-row"><span className="label">Pallets</span><span className="value">{fmt(pallets)}</span></div>
        <div className="amount-row"><span className="label">Subtotal</span><span className="value">{fmt(subtotal)}</span></div>
        <div className="amount-row"><span className="label">Comdata / Express Codes</span><span className="value red">-{fmt(comdataTotal)}</span></div>
        <div className="net-total" style={{marginTop:12}}>
          <span className="label">NET BILLABLE TOTAL</span>
          <span className="value">{fmt(netPay)}</span>
        </div>
      </div>

      <button className="scan-btn success" onClick={generatePDF} style={{marginBottom:8}}>
        DOWNLOAD INVOICE + ALL RECEIPTS
      </button>
      <button className="scan-btn secondary" onClick={resetLoad}>
        + START NEW LOAD
      </button>

    </div>
  )
}
