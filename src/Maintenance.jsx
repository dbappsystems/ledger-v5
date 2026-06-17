// src/Maintenance.jsx
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — Maintenance Ledger
//
// AUTH MIGRATION: all 13 calls go through the token api() client. The `api`
// URL prop is gone. The receipt-view link uses a ?t=<token> query.
//   WORKER TODO: the maintenance-receipt GET must also accept ?t=<token>
//   (a plain <a> link can't send the Authorization header).
//
// PER-TENANT SPLIT: computeRunningBalance now receives ownerCutPct (from tenant
// settings; default 10 keeps Edgerton unchanged) so the "balance owed to driver"
// number matches the Settlement Report under any split.
//
// WHITE-LABEL TODO: this file hardcodes the Tim↔EDGERTON financing relationship
// (paid_by 'EDGERTON', /api/escrow-payments/TIM, the "ETTR Financed Repair" fund
// tracker, and the TIM/EDGERTON toggle). That financing feature is Edgerton-
// specific business logic — for other tenants it must be generalized (per-tenant
// financer label, or hidden entirely) rather than assuming a driver named TIM and
// a company named EDGERTON.
//
// ACCRUAL: repair expense posts at entry_date; financed-repair payback is debt
// service / reserve contribution, never an expense line.

import { useState, useEffect, useRef } from 'react'
import { api as apiClient, apiUrl, getToken } from './api.js'
import { computeRunningBalance } from './settlementMath'

const CATEGORIES = ['Repair', 'Parts', 'Maintenance', 'Equipment', 'Fuel', 'Other']
const CAT_COLORS = {
  Repair:      '#e53935',
  Parts:       '#1e88e5',
  Maintenance: '#ffb300',
  Equipment:   '#8e24aa',
  Fuel:        '#00acc1',
  Other:       '#757575',
}
const CAT_ICONS = {
  Repair:      '🔧',
  Parts:       '⚙️',
  Maintenance: '🛠️',
  Equipment:   '📦',
  Fuel:        '⛽',
  Other:       '📝',
}
const TYPE_ICONS = {
  'Truck':           '🚛',
  'Trailer':         '🚚',
  'Refer Unit':      '❄️',
  'Other Equipment': '⚙️',
}

export default function Maintenance({ driver, showToast, onEntriesChange, role, ownerCutPct = 10 }) {
  const [entries,            setEntries]            = useState([])
  const [assets,             setAssets]             = useState([])
  const [loading,            setLoading]            = useState(true)
  const [showForm,           setShowForm]           = useState(false)
  const [filter,             setFilter]             = useState('All')
  const [confirmDelete,      setConfirmDelete]      = useState(null)
  const [deleting,           setDeleting]           = useState(false)
  const [uploading,          setUploading]          = useState(null)
  const [saving,             setSaving]             = useState(false)
  const [toggling,           setToggling]           = useState(null)
  const [scanning,           setScanning]           = useState(false)
  const [scannedImage,       setScannedImage]       = useState(null)

  // ── REPAIR ESCROW STATE ───────────────────────────────────
  const [escrowPayments,      setEscrowPayments]      = useState([])
  const [escrowPaymentsTotal, setEscrowPaymentsTotal] = useState(0)
  const [showFundEscrow,      setShowFundEscrow]      = useState(false)
  const [fundEscrowAmount,    setFundEscrowAmount]    = useState('')
  const [fundingEscrow,       setFundingEscrow]       = useState(false)
  const [timSettlementOwed,   setTimSettlementOwed]   = useState(null)

  const isBookkeeper = role === 'bookkeeper'
  const isTim        = driver === 'TIM'

  const [form, setForm] = useState({
    entry_date:  new Date().toISOString().split('T')[0],
    category:    'Repair',
    description: '',
    amount:      '',
    paid_by:     'TIM',
    asset_id:    '',
  })

  const scanInputRef   = useRef()
  const receiptFileRef = useRef()
  const uploadId       = useRef(null)

  useEffect(() => { fetchAll() }, [driver])

  async function fetchAll() {
    setLoading(true)
    try {
      const [eData, aData] = await Promise.all([
        apiClient('/api/maintenance/' + driver).catch(() => []),
        apiClient('/api/assets/' + driver).catch(() => []),
      ])
      const list = Array.isArray(eData) ? eData : []
      setEntries(list)
      setAssets(Array.isArray(aData) ? aData : [])
      if (onEntriesChange) onEntriesChange(list)
    } catch (err) {
      console.error('Failed to load:', err)
    } finally {
      setLoading(false)
    }
    if (isTim && !isBookkeeper) fetchEscrowPayments()
  }

  async function fetchEscrowPayments() {
    try {
      const data = await apiClient('/api/escrow-payments/TIM')
      const payments = Array.isArray(data) ? data : []
      setEscrowPayments(payments)
      setEscrowPaymentsTotal(payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0))
    } catch (err) {
      console.error('Escrow payments fetch (non-fatal):', err)
    }
  }

  async function fetchTimSettlementOwed() {
    try {
      const [allLoads, fuelData, escrowData] = await Promise.all([
        apiClient('/api/loads').catch(() => []),
        apiClient('/api/fuel/TIM').catch(() => []),
        apiClient('/api/escrow-payments/TIM').catch(() => []),
      ])
      const loads       = Array.isArray(allLoads)   ? allLoads   : []
      const fuelEntries = Array.isArray(fuelData)   ? fuelData   : []
      const payments    = Array.isArray(escrowData) ? escrowData : []

      // Refresh escrow state from the same fetch — the toggle/delete guards
      // and the balance tracker read these, so they stay in lockstep.
      const escrowTotal = payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0)
      setEscrowPayments(payments)
      setEscrowPaymentsTotal(escrowTotal)

      // ONE formula — src/settlementMath.js. Same number as the
      // Settlement Report, always. Per-tenant split via ownerCutPct.
      const rb = computeRunningBalance({ loads, fuelEntries, escrowTotal, driver: 'TIM', ownerCutPct })
      setTimSettlementOwed(rb.stillOwed)
    } catch (err) {
      console.error('Settlement fetch failed:', err)
      setTimSettlementOwed(0)
    }
  }

  // ── B&W PIPELINE — LOCKED DO NOT MODIFY ──────────────────
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
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, ki = 0
        for (let ky = -1; ky <= 1; ky++) for (let kx = -1; kx <= 1; kx++) {
          sum += gray[Math.min(Math.max(y+ky,0),h-1)*w+Math.min(Math.max(x+kx,0),w-1)] * kernel[ki++]
        }
        blurred[y*w+x] = Math.round(sum/kSum)
      }
    }
    const S = Math.floor(Math.max(w,h)/16), T = 0.15
    const integ = new Int32Array(w*h)
    for (let y = 0; y < h; y++) { let rs = 0; for (let x = 0; x < w; x++) { rs += blurred[y*w+x]; integ[y*w+x] = rs + (y>0?integ[(y-1)*w+x]:0) } }
    const bw = new Uint8ClampedArray(w*h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x1=Math.max(x-S,0),y1=Math.max(y-S,0),x2=Math.min(x+S,w-1),y2=Math.min(y+S,h-1)
      const count=(x2-x1)*(y2-y1)
      const sum=integ[y2*w+x2]-(x1>0?integ[y2*w+(x1-1)]:0)-(y1>0?integ[(y1-1)*w+x2]:0)+(x1>0&&y1>0?integ[(y1-1)*w+(x1-1)]:0)
      bw[y*w+x]=(blurred[y*w+x]*count)<(sum*(1-T))?0:255
    }
    const sharp = new Uint8ClampedArray(w*h), amount = 1.5
    for (let i = 0; i < bw.length; i++) sharp[i] = Math.min(255,Math.max(0,Math.round(bw[i]+amount*(bw[i]-blurred[i]))))
    for (let i = 0; i < sharp.length; i++) { const p=i*4; data[p]=data[p+1]=data[p+2]=sharp[i]; data[p+3]=255 }
    ctx.putImageData(id,0,0)
    const dataUrl = canvas.toDataURL('image/jpeg',0.92)
    return { dataUrl, base64: dataUrl.split(',')[1], w, h }
  }

  async function processFile(file) {
    const isPdf = file.type==='application/pdf'||file.name.toLowerCase().endsWith('.pdf')
    let canvas
    if (isPdf) {
      const pdfjsLib = window.pdfjsLib
      if (!pdfjsLib) throw new Error('PDF.js not loaded')
      const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise
      const page = await pdf.getPage(1)
      const MAX=1200, baseVP=page.getViewport({scale:1})
      const scale=Math.min(MAX/baseVP.width,MAX/baseVP.height,2.0)
      const viewport=page.getViewport({scale})
      canvas=document.createElement('canvas')
      canvas.width=Math.round(viewport.width); canvas.height=Math.round(viewport.height)
      await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise
    } else {
      canvas = await new Promise((resolve,reject) => {
        const reader=new FileReader()
        reader.onerror=reject
        reader.onload=(ev)=>{
          const img=new Image()
          img.onerror=reject
          img.onload=()=>{
            const MAX=1200; let w=img.naturalWidth||800,h=img.naturalHeight||1000
            if(w>MAX){h=Math.round(h*MAX/w);w=MAX} if(h>MAX){w=Math.round(w*MAX/h);h=MAX}
            const c=document.createElement('canvas'); c.width=w; c.height=h
            c.getContext('2d').drawImage(img,0,0,w,h); resolve(c)
          }
          img.src=ev.target.result
        }
        reader.readAsDataURL(file)
      })
    }
    return { ...applyBWPipeline(canvas), name: file.name, isPdf }
  }

  async function handleScan(e) {
    const file = e.target.files[0]
    if (!file) return
    setScanning(true)
    showToast('📡 Scanning receipt...')
    try {
      const processed = await processFile(file)
      const base64 = await new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=reject;r.onload=()=>resolve(r.result.split(',')[1]);r.readAsDataURL(file)})
      const isPdf = file.type==='application/pdf'||file.name.toLowerCase().endsWith('.pdf')
      const json = await apiClient('/api/ocr',{method:'POST',json:{base64,mediaType:isPdf?'application/pdf':(file.type||'image/jpeg'),mode:'incidental'}})
      if (json.error) throw new Error(json.detail||json.error)
      let raw = (json.result||'').replace(/```json/gi,'').replace(/```/gi,'').trim()
      const start=raw.indexOf('{'),end=raw.lastIndexOf('}')
      if(start===-1||end===-1) throw new Error('No data found')
      const parsed=JSON.parse(raw.substring(start,end+1))
      setScannedImage({...processed,name:file.name})
      setForm(p=>({...p,amount:parsed.amount||'0.00'}))
      showToast('✅ Receipt scanned! $'+(parsed.amount||'0.00'))
    } catch(err) {
      showToast('❌ Scan failed — enter amount manually')
      console.error(err)
    } finally {
      setScanning(false)
      e.target.value=''
    }
  }

  async function saveEntry() {
    if (!form.description.trim()) { showToast('Enter a description'); return }
    if (!form.amount||parseFloat(form.amount)<=0) { showToast('Enter a valid amount'); return }
    if (!form.entry_date) { showToast('Select a date'); return }
    setSaving(true)
    try {
      const data = await apiClient('/api/maintenance',{method:'POST',
        json:{driver,entry_date:form.entry_date,category:form.category,description:form.description.trim(),amount:parseFloat(form.amount),paid_by:form.paid_by,asset_id:form.asset_id}})
      if(scannedImage&&data.id) {
        try {
          await apiClient('/api/maintenance-receipt/'+data.id,{method:'POST',json:{base64:scannedImage.base64,mediaType:'image/jpeg'}})
        } catch(err) { console.error('Receipt upload failed:',err) }
      }
      showToast('✅ Entry saved!')
      setForm({entry_date:new Date().toISOString().split('T')[0],category:'Repair',description:'',amount:'',paid_by:'TIM',asset_id:''})
      setScannedImage(null)
      setShowForm(false)
      await fetchAll()
    } catch(err) {
      showToast('⚠️ Save failed: '+err.message)
    } finally {
      setSaving(false)
    }
  }

  async function togglePaidBy(entry) {
    const newVal = entry.paid_by==='EDGERTON'?'TIM':'EDGERTON'
    // SIGNED FUND: no hard block needed — if payments exceed the financed
    // pool after this change, the difference shows as repair reserve on
    // deposit. Money is never orphaned; the position self-corrects.
    setToggling(entry.id)
    try {
      await apiClient('/api/maintenance/'+entry.id,{
        method: 'PATCH',
        json: {
          paid_by:              newVal,
          paid_by_changed_at:   new Date().toISOString(),
          paid_by_changed_from: entry.paid_by,
        },
      })
      setEntries(prev=>prev.map(e=>e.id===entry.id?{...e,paid_by:newVal}:e))
      if (newVal === 'TIM') {
        showToast('✅ Moved to Tim Paid — repair balance updated')
      } else {
        showToast('🏦 Added to ETTR Financed Repair')
      }
    } catch(err) { showToast('⚠️ Update failed: '+err.message) }
    finally { setToggling(null) }
  }

  async function fundEscrow() {
    const amt = parseFloat(fundEscrowAmount)
    if (!amt || amt <= 0) { showToast('Enter a valid amount'); return }
    // SIGNED FUND: paying past zero is allowed — the excess builds the
    // repair reserve. Only cap: money must exist in the settlement.
    if (timSettlementOwed !== null && amt > timSettlementOwed) {
      showToast('Amount exceeds your balance owed — check your settlement report'); return
    }
    setFundingEscrow(true)
    try {
      await apiClient('/api/escrow-payment', {
        method: 'POST',
        json: {
          driver:     'TIM',
          amount:     amt,
          funded_at:  new Date().toISOString(),
        },
      })
      showToast('✅ Repair payment applied — $' + amt.toFixed(2))
      setFundEscrowAmount('')
      setShowFundEscrow(false)
      setTimSettlementOwed(null)
      await fetchAll()
    } catch (err) {
      showToast('⚠️ Fund failed: ' + err.message)
    } finally {
      setFundingEscrow(false)
    }
  }

  async function deleteEntry(entry) {
    // SIGNED FUND: deleting a financed entry just moves the fund position
    // toward reserve — payments stay tracked, nothing is orphaned.
    setDeleting(true)
    try {
      try {
        await apiClient('/api/maintenance/'+entry.id,{method:'DELETE',json:{driver}})
      } catch(e){ showToast('⚠️ Delete failed: '+(e.message||'unknown')); return }
      showToast('✅ Entry deleted')
      setConfirmDelete(null)
      await fetchAll()
    } catch(err) { showToast('⚠️ Delete failed: '+err.message) }
    finally { setDeleting(false) }
  }

  function openReceiptUpload(id) { uploadId.current=id; receiptFileRef.current.click() }

  async function handleReceiptUpload(e) {
    const file=e.target.files[0]; if(!file) return
    const id=uploadId.current; setUploading(id); showToast('📤 Uploading receipt...')
    try {
      const base64=await new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=reject;r.onload=()=>resolve(r.result.split(',')[1]);r.readAsDataURL(file)})
      const mediaType=file.type==='application/pdf'?'application/pdf':'image/jpeg'
      await apiClient('/api/maintenance-receipt/'+id,{method:'POST',json:{base64,mediaType}})
      showToast('✅ Receipt uploaded!')
      await fetchAll()
    } catch(err) { showToast('⚠️ Upload failed: '+err.message) }
    finally { setUploading(null); e.target.value='' }
  }

  function fmt(n) { return '$'+(parseFloat(n)||0).toFixed(2) }

  // ── BOOKKEEPER FILTER: hide EDGERTON paid entries from the bookkeeper ──
  const visibleEntries = isBookkeeper
    ? entries.filter(e => e.paid_by !== 'EDGERTON')
    : entries

  const filtered      = filter==='All' ? visibleEntries : visibleEntries.filter(e=>e.category===filter)
  const totalAll      = visibleEntries.reduce((s,e)=>s+(parseFloat(e.amount)||0),0)
  const totalMonth    = visibleEntries.filter(e=>{if(!e.entry_date)return false;const d=new Date(e.entry_date),now=new Date();return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()}).reduce((s,e)=>s+(parseFloat(e.amount)||0),0)
  const totalEdgerton = entries.filter(e=>e.paid_by==='EDGERTON').reduce((s,e)=>s+(parseFloat(e.amount)||0),0)
  const totalTimPaid  = entries.filter(e=>e.paid_by!=='EDGERTON').reduce((s,e)=>s+(parseFloat(e.amount)||0),0)
  const totalFiltered = filtered.reduce((s,e)=>s+(parseFloat(e.amount)||0),0)

  // ETTR FINANCED REPAIR — SIGNED capital account between Tim and ETTR.
  // fundPosition = payments in − repairs financed.
  //   negative → balance owed to ETTR (capital advanced ahead of earnings)
  //   positive → repair reserve on deposit (pre-funded for unplanned repairs)
  // A future ETTR-financed repair raises totalEdgerton, which draws the
  // reserve down first before creating new debt — pure arithmetic.
  const fundPosition = escrowPaymentsTotal - totalEdgerton
  const fundOwed     = Math.max(0, -fundPosition)
  const fundReserve  = Math.max(0,  fundPosition)
  const fundSettled  = (totalEdgerton > 0 || escrowPaymentsTotal > 0) && fundPosition === 0

  if (loading) return <div className="empty-state"><div className="icon">🔧</div><h3>LOADING...</h3></div>

  return (
    <div>
      <input ref={scanInputRef}   type="file" accept="application/pdf,image/*" style={{display:'none'}} onChange={handleScan} />
      <input ref={receiptFileRef} type="file" accept="application/pdf,image/*" style={{display:'none'}} onChange={handleReceiptUpload} />

      {/* HEADER CARD */}
      <div className="card" style={{marginBottom:14}}>
        <div className="section-title" style={{marginBottom:8}}>{driver} — MAINTENANCE LEDGER</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
          <div style={{background:'var(--navy3)',borderRadius:8,padding:'10px 12px'}}>
            <div style={{fontSize:10,color:'var(--grey)',fontFamily:'var(--font-head)',letterSpacing:'0.08em',marginBottom:4}}>THIS MONTH</div>
            <div style={{fontFamily:'var(--font-head)',fontSize:18,fontWeight:900,color:'#e53935'}}>{fmt(totalMonth)}</div>
          </div>
          <div style={{background:'var(--navy3)',borderRadius:8,padding:'10px 12px'}}>
            <div style={{fontSize:10,color:'var(--grey)',fontFamily:'var(--font-head)',letterSpacing:'0.08em',marginBottom:4}}>ALL TIME</div>
            <div style={{fontFamily:'var(--font-head)',fontSize:18,fontWeight:900,color:'var(--amber)'}}>{fmt(totalAll)}</div>
          </div>
        </div>

        {/* PAYMENT SUMMARY — drivers only, not bookkeeper */}
        {!isBookkeeper && (
          <div style={{borderTop:'1px solid var(--border)',paddingTop:10}}>
            <div style={{fontSize:10,color:'var(--grey)',fontFamily:'var(--font-head)',letterSpacing:'0.08em',marginBottom:8}}>PAYMENT SUMMARY — ALL TIME</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              <div style={{background:'#1a2a0a',borderRadius:8,padding:'10px 12px',border:'1px solid #2e7d32'}}>
                <div style={{fontSize:10,color:'#66bb6a',fontFamily:'var(--font-head)',letterSpacing:'0.06em',marginBottom:4}}>TIM PAID</div>
                <div style={{fontFamily:'var(--font-head)',fontSize:16,fontWeight:900,color:'#66bb6a'}}>{fmt(totalTimPaid)}</div>
                <div style={{fontSize:10,color:'var(--grey)',marginTop:2}}>No reimbursement needed</div>
              </div>
              <div style={{background:'#1a0a2a',borderRadius:8,padding:'10px 12px',border:'1px solid #7b1fa2'}}>
                <div style={{fontSize:10,color:'#ce93d8',fontFamily:'var(--font-head)',letterSpacing:'0.06em',marginBottom:4}}>ETTR FINANCED</div>
                <div style={{fontFamily:'var(--font-head)',fontSize:16,fontWeight:900,color:'#ce93d8'}}>{fmt(totalEdgerton)}</div>
                <div style={{fontSize:10,color:'var(--grey)',marginTop:2}}>Total Financed — All Time</div>
              </div>
            </div>

            {/* ETTR FINANCED REPAIR FUND — signed position tracker */}
            {(totalEdgerton > 0 || escrowPaymentsTotal > 0) && (
              <div style={{marginTop:8}}>
                {fundOwed > 0 && (
                  <div style={{
                    padding:'10px 12px',
                    background:'#2a0a2a',
                    border:'1px solid #ce93d8',
                    borderRadius:8,
                    display:'flex',
                    justifyContent:'space-between',
                    alignItems:'center',
                    marginBottom: escrowPaymentsTotal > 0 ? 4 : 8,
                  }}>
                    <span style={{fontSize:12,fontFamily:'var(--font-head)',fontWeight:700,color:'#ce93d8'}}>
                      🏦 BALANCE OWED TO ETTR
                    </span>
                    <span style={{fontSize:18,fontFamily:'var(--font-head)',fontWeight:900,color:'#ce93d8'}}>
                      -{fmt(fundOwed)}
                    </span>
                  </div>
                )}

                {fundReserve > 0 && (
                  <div style={{
                    padding:'10px 12px',
                    background:'#0a2a0a',
                    border:'1px solid #2e7d32',
                    borderRadius:8,
                    marginBottom: escrowPaymentsTotal > 0 ? 4 : 8,
                  }}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                      <span style={{fontSize:12,fontFamily:'var(--font-head)',fontWeight:700,color:'#66bb6a'}}>
                        💰 REPAIR RESERVE ON DEPOSIT
                      </span>
                      <span style={{fontSize:18,fontFamily:'var(--font-head)',fontWeight:900,color:'#66bb6a'}}>
                        +{fmt(fundReserve)}
                      </span>
                    </div>
                    <div style={{fontSize:10,color:'var(--grey)',marginTop:4}}>
                      Capital ready for unplanned repairs — the next ETTR financed repair draws from this first.
                    </div>
                  </div>
                )}

                {fundSettled && (
                  <div style={{
                    padding:'10px 12px',
                    background:'#0a2a0a',
                    border:'1px solid #2e7d32',
                    borderRadius:8,
                    display:'flex',
                    justifyContent:'space-between',
                    alignItems:'center',
                    marginBottom: escrowPaymentsTotal > 0 ? 4 : 8,
                  }}>
                    <span style={{fontSize:12,fontFamily:'var(--font-head)',fontWeight:700,color:'#66bb6a'}}>
                      ✅ ETTR FINANCED REPAIR BALANCE
                    </span>
                    <span style={{fontSize:18,fontFamily:'var(--font-head)',fontWeight:900,color:'#66bb6a'}}>
                      {fmt(0)}
                    </span>
                  </div>
                )}

                {escrowPaymentsTotal > 0 && (
                  <div style={{fontSize:10,color:'#66bb6a',fontFamily:'var(--font-head)',textAlign:'right',marginBottom:8}}>
                    ✅ {fmt(escrowPaymentsTotal)} paid into the repair fund
                  </div>
                )}

                {/* FUND BUTTON — Tim only, not bookkeeper, always available */}
                {isTim && (
                  <button
                    onClick={() => {
                      const next = !showFundEscrow
                      setShowFundEscrow(next)
                      if (next) {
                        setTimSettlementOwed(null)
                        fetchTimSettlementOwed()
                      } else {
                        setFundEscrowAmount('')
                      }
                    }}
                    style={{
                      width:'100%', padding:'12px 0', borderRadius:8, border:'none',
                      background: showFundEscrow ? 'var(--navy3)' : (fundOwed > 0 ? '#4a148c' : '#1b5e20'),
                      color:      showFundEscrow ? 'var(--grey)'  : (fundOwed > 0 ? '#ce93d8' : '#a5d6a7'),
                      fontSize:13, fontFamily:'var(--font-head)', fontWeight:900,
                      cursor:'pointer', letterSpacing:'0.06em', marginBottom:8,
                    }}
                  >
                    {showFundEscrow ? '✕ CANCEL' : (fundOwed > 0 ? '💳 MAKE REPAIR PAYMENT' : '💰 ADD TO REPAIR RESERVE')}
                  </button>
                )}

                {/* FUND PANEL */}
                {showFundEscrow && isTim && (
                  <div style={{
                    background:'#1a0a2a',
                    border:'1px solid #7b1fa2',
                    borderRadius:10,
                    padding:16,
                    marginBottom:8,
                  }}>
                    <div style={{fontSize:12,fontFamily:'var(--font-head)',fontWeight:900,color:'#ce93d8',letterSpacing:'0.08em',marginBottom:12}}>
                      {fundOwed > 0 ? '💳 PAY ETTR FINANCED REPAIR' : '💰 ADD TO REPAIR RESERVE'}
                    </div>

                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
                      <div style={{background:'var(--navy3)',borderRadius:8,padding:'10px 12px'}}>
                        <div style={{fontSize:10,color:'var(--grey)',fontFamily:'var(--font-head)',letterSpacing:'0.06em',marginBottom:4}}>FUND POSITION</div>
                        <div style={{fontFamily:'var(--font-head)',fontSize:15,fontWeight:900,color: fundOwed > 0 ? '#ce93d8' : '#66bb6a'}}>
                          {fundOwed > 0 ? '-' + fmt(fundOwed) : '+' + fmt(fundReserve)}
                        </div>
                      </div>
                      <div style={{background:'var(--navy3)',borderRadius:8,padding:'10px 12px'}}>
                        <div style={{fontSize:10,color:'var(--grey)',fontFamily:'var(--font-head)',letterSpacing:'0.06em',marginBottom:4}}>BALANCE OWED TO TIM</div>
                        <div style={{fontFamily:'var(--font-head)',fontSize:15,fontWeight:900,color:'var(--amber)'}}>
                          {timSettlementOwed === null ? 'Loading...' : fmt(timSettlementOwed)}
                        </div>
                      </div>
                    </div>

                    <div style={{fontSize:10,color:'var(--grey)',fontFamily:'var(--font-head)',marginBottom:12}}>
                      Enter the amount to apply from your settlement. It pays down the balance owed to ETTR first — anything beyond that builds your repair reserve.
                    </div>

                    <div style={{marginBottom:12}}>
                      <div style={{fontSize:11,color:'var(--grey)',fontFamily:'var(--font-head)',letterSpacing:'0.06em',marginBottom:6}}>AMOUNT TO FUND ($)</div>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={fundEscrowAmount}
                        onChange={e => setFundEscrowAmount(e.target.value)}
                        style={{
                          width:'100%', background:'var(--navy3)',
                          border:'1px solid #7b1fa2',
                          color:'var(--white)', borderRadius:8,
                          padding:'12px 14px', fontSize:22,
                          fontFamily:'var(--font-head)', fontWeight:700,
                          boxSizing:'border-box',
                        }}
                      />
                    </div>

                    {fundEscrowAmount && parseFloat(fundEscrowAmount) > 0 && (() => {
                      const amt = parseFloat(fundEscrowAmount)
                      const newPosition = fundPosition + amt
                      return (
                        <div style={{
                          background:'var(--navy3)', borderRadius:8,
                          padding:'10px 12px', marginBottom:12,
                          border:'1px solid var(--border)', fontSize:12,
                        }}>
                          <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                            <span style={{color:'var(--grey)'}}>Current position</span>
                            <span style={{fontFamily:'var(--font-head)',fontWeight:700,color: fundPosition < 0 ? '#ce93d8' : '#66bb6a'}}>
                              {fundPosition < 0 ? '-' + fmt(-fundPosition) : '+' + fmt(fundPosition)}
                            </span>
                          </div>
                          <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                            <span style={{color:'var(--grey)'}}>Payment</span>
                            <span style={{fontFamily:'var(--font-head)',fontWeight:700,color:'#66bb6a'}}>+{fmt(amt)}</span>
                          </div>
                          <div style={{borderTop:'1px solid var(--border)',marginTop:6,paddingTop:6,display:'flex',justifyContent:'space-between'}}>
                            <span style={{fontWeight:700,color:'var(--white)'}}>New position</span>
                            <span style={{
                              fontFamily:'var(--font-head)', fontWeight:900,
                              color: newPosition < 0 ? '#ce93d8' : '#66bb6a',
                            }}>
                              {newPosition < 0
                                ? '-' + fmt(-newPosition)
                                : newPosition > 0
                                  ? '💰 +' + fmt(newPosition) + ' reserve'
                                  : '✅ ' + fmt(0)
                              }
                            </span>
                          </div>
                        </div>
                      )
                    })()}

                    <button
                      disabled={!fundEscrowAmount || parseFloat(fundEscrowAmount) <= 0 || fundingEscrow}
                      onClick={fundEscrow}
                      style={{
                        width:'100%', padding:'14px 0', borderRadius:8, border:'none',
                        background: (!fundEscrowAmount || parseFloat(fundEscrowAmount) <= 0 || fundingEscrow)
                          ? '#555' : '#7b1fa2',
                        color:'#fff',
                        fontSize:14, fontFamily:'var(--font-head)', fontWeight:900,
                        cursor:'pointer', letterSpacing:'0.05em',
                      }}
                    >
                      {fundingEscrow ? 'APPLYING...' : '💳 APPLY PAYMENT'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {!showForm && <button className="scan-btn success" style={{marginBottom:14}} onClick={()=>setShowForm(true)}>+ ADD ENTRY</button>}

      {/* NEW ENTRY FORM */}
      {showForm&&(
        <div className="card" style={{marginBottom:14,border:'1px solid var(--amber)'}}>
          <div className="section-title" style={{marginBottom:12}}>NEW ENTRY</div>
          <div style={{marginBottom:14}}>
            <button disabled={scanning} onClick={()=>scanInputRef.current.click()} style={{
              width:'100%',padding:'14px 0',borderRadius:8,border:'1px solid var(--border)',
              background:scanning?'#555':'var(--navy3)',color:scanning?'var(--grey)':'var(--white)',
              fontSize:14,fontFamily:'var(--font-head)',fontWeight:900,cursor:'pointer',
            }}>{scanning?'📡 Scanning...':'📷 SCAN RECEIPT — Auto-fill Amount'}</button>
            {scannedImage&&(
              <div style={{marginTop:8,display:'flex',alignItems:'center',gap:10,background:'var(--navy3)',borderRadius:8,padding:'8px 10px',border:'1px solid var(--green)'}}>
                <img src={scannedImage.dataUrl} alt="Scanned" style={{width:48,height:48,objectFit:'cover',borderRadius:6,border:'1px solid var(--border)',flexShrink:0}} />
                <div style={{flex:1}}>
                  <div style={{fontSize:11,color:'var(--green)',fontFamily:'var(--font-head)',fontWeight:700}}>✅ Receipt scanned</div>
                  <div style={{fontSize:10,color:'var(--grey)',marginTop:2}}>{scannedImage.name}</div>
                </div>
                <button onClick={()=>setScannedImage(null)} style={{background:'transparent',border:'none',color:'var(--grey)',fontSize:16,cursor:'pointer',padding:'4px 8px'}}>x</button>
              </div>
            )}
          </div>
          <div className="field-row" style={{marginBottom:10}}>
            <div className="field-label">Date</div>
            <input type="date" value={form.entry_date} onChange={e=>setForm(p=>({...p,entry_date:e.target.value}))}
              style={{background:'var(--navy3)',border:'1px solid var(--border)',color:'var(--white)',borderRadius:8,padding:'10px 12px',fontSize:15,width:'100%',boxSizing:'border-box'}} />
          </div>
          {assets.length > 0 && (
            <div style={{marginBottom:10}}>
              <div className="field-label" style={{marginBottom:6}}>Link to Asset (optional)</div>
              <div style={{display:'flex',flexDirection:'column',gap:6}}>
                <button onClick={()=>setForm(p=>({...p,asset_id:''}))} style={{
                  padding:'9px 12px',borderRadius:8,border:'none',textAlign:'left',
                  background:form.asset_id===''?'var(--navy2)':'var(--navy3)',
                  color:form.asset_id===''?'var(--white)':'var(--grey)',
                  fontSize:12,fontFamily:'var(--font-head)',fontWeight:700,cursor:'pointer',
                  outline:form.asset_id===''?'1px solid var(--border)':'none',
                }}>— No specific asset</button>
                {assets.map(a=>(
                  <button key={a.id} onClick={()=>setForm(p=>({...p,asset_id:a.id}))} style={{
                    padding:'9px 12px',borderRadius:8,border:'none',textAlign:'left',
                    background:form.asset_id===a.id?'var(--navy2)':'var(--navy3)',
                    color:form.asset_id===a.id?'var(--white)':'var(--grey)',
                    fontSize:12,fontFamily:'var(--font-head)',fontWeight:700,cursor:'pointer',
                    outline:form.asset_id===a.id?'1px solid var(--amber)':'none',
                  }}>{TYPE_ICONS[a.asset_type]||'⚙️'} {a.asset_name}{a.year?' — '+a.year:''}</button>
                ))}
              </div>
            </div>
          )}
          <div style={{marginBottom:10}}>
            <div className="field-label" style={{marginBottom:6}}>Category</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6}}>
              {CATEGORIES.map(cat=>(
                <button key={cat} onClick={()=>setForm(p=>({...p,category:cat}))} style={{
                  padding:'8px 4px',borderRadius:8,border:'none',
                  background:form.category===cat?CAT_COLORS[cat]:'var(--navy3)',
                  color:form.category===cat?'#fff':'var(--grey)',
                  fontSize:11,fontFamily:'var(--font-head)',fontWeight:700,cursor:'pointer',
                }}>{CAT_ICONS[cat]} {cat}</button>
              ))}
            </div>
          </div>
          <div className="field-row" style={{marginBottom:10}}>
            <div className="field-label">Description</div>
            <input type="text" value={form.description} onChange={e=>setForm(p=>({...p,description:e.target.value}))}
              placeholder="e.g. Oil change, new brake pads..."
              style={{background:'var(--navy3)',border:'1px solid var(--border)',color:'var(--white)',borderRadius:8,padding:'10px 12px',fontSize:15,width:'100%',boxSizing:'border-box'}} />
          </div>
          <div className="field-row" style={{marginBottom:12}}>
            <div className="field-label">Amount ($) {scannedImage?'— auto-filled':''}</div>
            <input type="text" inputMode="decimal" pattern="[0-9.]*" value={form.amount}
              onChange={e=>setForm(p=>({...p,amount:e.target.value}))} placeholder="0.00"
              style={{background:'var(--navy3)',border:scannedImage?'1px solid var(--green)':'1px solid var(--amber)',color:'var(--white)',borderRadius:8,padding:'10px 12px',fontSize:22,fontFamily:'var(--font-head)',fontWeight:700,width:'100%',boxSizing:'border-box'}} />
          </div>

          {/* PAID BY — drivers only, not bookkeeper */}
          {!isBookkeeper && (
            <div style={{marginBottom:14}}>
              <div className="field-label" style={{marginBottom:8}}>Paid By</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                <button onClick={()=>setForm(p=>({...p,paid_by:'TIM'}))} style={{
                  padding:'12px 0',borderRadius:8,border:'none',
                  background:form.paid_by==='TIM'?'#2e7d32':'var(--navy3)',
                  color:form.paid_by==='TIM'?'#fff':'var(--grey)',
                  fontSize:13,fontFamily:'var(--font-head)',fontWeight:900,cursor:'pointer',
                  borderLeft:form.paid_by==='TIM'?'3px solid #66bb6a':'3px solid transparent',
                }}>✅ TIM PAID</button>
                <button onClick={()=>setForm(p=>({...p,paid_by:'EDGERTON'}))} style={{
                  padding:'12px 0',borderRadius:8,border:'none',
                  background:form.paid_by==='EDGERTON'?'#4a148c':'var(--navy3)',
                  color:form.paid_by==='EDGERTON'?'#fff':'var(--grey)',
                  fontSize:13,fontFamily:'var(--font-head)',fontWeight:900,cursor:'pointer',
                  borderLeft:form.paid_by==='EDGERTON'?'3px solid #ce93d8':'3px solid transparent',
                }}>🏦 ETTR FINANCED</button>
              </div>
              {form.paid_by==='EDGERTON'&&(
                <div style={{fontSize:11,color:'#ce93d8',marginTop:6,fontFamily:'var(--font-head)'}}>
                  ⚠️ This amount will be added to the ETTR financed repair balance
                </div>
              )}
            </div>
          )}

          <div style={{display:'flex',gap:8}}>
            <button disabled={saving} onClick={saveEntry} style={{
              flex:1,padding:'14px 0',borderRadius:8,border:'none',
              background:saving?'#555':'var(--amber)',color:'var(--navy)',
              fontSize:15,fontFamily:'var(--font-head)',fontWeight:900,cursor:'pointer',
            }}>{saving?'SAVING...':'SAVE ENTRY'}</button>
            <button onClick={()=>{setShowForm(false);setScannedImage(null);setForm({entry_date:new Date().toISOString().split('T')[0],category:'Repair',description:'',amount:'',paid_by:'TIM',asset_id:''})}} style={{
              flex:1,padding:'14px 0',borderRadius:8,border:'1px solid var(--border)',
              background:'transparent',color:'var(--grey)',
              fontSize:15,fontFamily:'var(--font-head)',fontWeight:700,cursor:'pointer',
            }}>CANCEL</button>
          </div>
        </div>
      )}

      {/* FILTER BAR */}
      <div style={{display:'flex',gap:6,overflowX:'auto',paddingBottom:6,marginBottom:14}}>
        {['All',...CATEGORIES].map(cat=>(
          <button key={cat} onClick={()=>setFilter(cat)} style={{
            padding:'8px 12px',borderRadius:8,border:'none',
            background:filter===cat?(cat==='All'?'var(--amber)':CAT_COLORS[cat]):'var(--navy3)',
            color:filter===cat?(cat==='All'?'var(--navy)':'#fff'):'var(--grey)',
            fontSize:11,fontFamily:'var(--font-head)',fontWeight:700,cursor:'pointer',whiteSpace:'nowrap',flexShrink:0,
          }}>{cat==='All'?'ALL':CAT_ICONS[cat]+' '+cat}</button>
        ))}
      </div>

      {filter!=='All'&&(
        <div style={{textAlign:'center',fontFamily:'var(--font-head)',fontSize:13,color:CAT_COLORS[filter],letterSpacing:'0.08em',marginBottom:10}}>
          {CAT_ICONS[filter]} {filter.toUpperCase()} TOTAL: {fmt(totalFiltered)}
        </div>
      )}

      {filtered.length===0&&(
        <div className="empty-state">
          <div className="icon">🔧</div>
          <h3>NO ENTRIES</h3>
          <p>{filter==='All'?'Tap + ADD ENTRY to get started':'No '+filter+' entries yet'}</p>
        </div>
      )}

      {/* ENTRY CARDS */}
      {filtered.map(entry=>{
        const isPending   = confirmDelete===entry.id
        const isUploading = uploading===entry.id
        const isToggling  = toggling===entry.id
        const catColor    = CAT_COLORS[entry.category]||'var(--grey)'
        const isEdgerton  = entry.paid_by==='EDGERTON'
        const linkedAsset = assets.find(a=>a.id===entry.asset_id)
        return (
          <div className="load-card" key={entry.id} style={{borderLeft:'3px solid '+catColor}}>
            <div style={{flex:1}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:6}}>
                <div style={{display:'inline-flex',alignItems:'center',gap:4,padding:'2px 8px',borderRadius:10,background:catColor,color:'#fff',fontSize:10,fontFamily:'var(--font-head)',fontWeight:700}}>
                  {CAT_ICONS[entry.category]} {entry.category}
                </div>
                <div style={{fontSize:11,color:'var(--grey)'}}>
                  {entry.entry_date?new Date(entry.entry_date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'-'}
                </div>
              </div>
              {linkedAsset&&(
                <div style={{display:'inline-flex',alignItems:'center',gap:4,padding:'2px 8px',borderRadius:6,background:'var(--navy3)',border:'1px solid var(--border)',fontSize:10,color:'var(--grey)',fontFamily:'var(--font-head)',marginBottom:6}}>
                  {TYPE_ICONS[linkedAsset.asset_type]||'⚙️'} {linkedAsset.asset_name}
                </div>
              )}
              <div style={{fontSize:15,color:'var(--white)',fontWeight:600,marginBottom:4}}>{entry.description||'-'}</div>
              <div style={{fontFamily:'var(--font-head)',fontSize:22,fontWeight:900,color:'#e53935',marginBottom:8}}>{fmt(entry.amount)}</div>

              {/* PAID BY TOGGLE — drivers only, not bookkeeper */}
              {!isBookkeeper && (
                <div style={{marginBottom:10}}>
                  <button disabled={isToggling} onClick={()=>togglePaidBy(entry)} style={{
                    padding:'8px 14px',borderRadius:8,border:'none',cursor:'pointer',
                    background:isEdgerton?'#4a148c':'#2e7d32',color:'#fff',
                    fontSize:12,fontFamily:'var(--font-head)',fontWeight:900,opacity:isToggling?0.6:1,
                  }}>
                    {isToggling
                      ? 'SAVING...'
                      : isEdgerton
                        ? '🏦 ETTR FINANCED — tap to change'
                        : '✅ TIM PAID — tap to change'
                    }
                  </button>
                  {isEdgerton&&(
                    <div style={{fontSize:10,color:'#ce93d8',marginTop:4,fontFamily:'var(--font-head)'}}>
                      ETTR financed — payback owed
                    </div>
                  )}
                </div>
              )}

              <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                <button disabled={isUploading} onClick={()=>openReceiptUpload(entry.id)} style={{
                  flex:1,padding:'8px 0',borderRadius:8,border:'1px solid var(--border)',background:'var(--navy3)',
                  color:isUploading?'var(--grey)':'var(--white)',fontSize:11,fontFamily:'var(--font-head)',fontWeight:700,cursor:'pointer',
                }}>{isUploading?'📤 Uploading...':entry.receipt_url?'📎 Replace Receipt':'📎 Add Receipt'}</button>
                {entry.receipt_url&&(
                  <a href={apiUrl(entry.receipt_url) + (getToken() ? ('?t='+encodeURIComponent(getToken())) : '')} target="_blank" rel="noopener noreferrer" style={{
                    flex:1,padding:'8px 0',borderRadius:8,border:'1px solid var(--amber)',background:'transparent',color:'var(--amber)',
                    fontSize:11,fontFamily:'var(--font-head)',fontWeight:700,textDecoration:'none',display:'flex',alignItems:'center',justifyContent:'center',
                  }}>👁 VIEW RECEIPT</a>
                )}
                {!isPending&&(
                  <button onClick={()=>setConfirmDelete(entry.id)} style={{
                    padding:'8px 12px',borderRadius:8,border:'1px solid #555',background:'transparent',color:'#888',
                    fontSize:11,fontFamily:'var(--font-head)',fontWeight:700,cursor:'pointer',
                  }}>DELETE</button>
                )}
              </div>

              {isPending&&(
                <div style={{marginTop:10,background:'#2a0a0a',border:'1px solid #e53935',borderRadius:8,padding:'12px 14px'}}>
                  <div style={{fontSize:12,color:'#e53935',fontFamily:'var(--font-head)',fontWeight:700,marginBottom:10}}>DELETE THIS ENTRY? CANNOT BE UNDONE.</div>
                  <div style={{display:'flex',gap:8}}>
                    <button disabled={deleting} onClick={()=>deleteEntry(entry)} style={{flex:1,padding:'10px 0',borderRadius:8,border:'none',background:deleting?'#555':'#e53935',color:'#fff',fontSize:13,fontFamily:'var(--font-head)',fontWeight:900,cursor:'pointer'}}>{deleting?'DELETING...':'CONFIRM DELETE'}</button>
                    <button disabled={deleting} onClick={()=>setConfirmDelete(null)} style={{flex:1,padding:'10px 0',borderRadius:8,border:'1px solid #555',background:'transparent',color:'#aaa',fontSize:13,fontFamily:'var(--font-head)',fontWeight:700,cursor:'pointer'}}>CANCEL</button>
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
