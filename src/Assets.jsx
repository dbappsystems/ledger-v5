// src/Assets.jsx
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — Equipment Assets
//
// AUTH MIGRATION: all 7 calls (assets list, per-asset payments, asset POST/PATCH/
// DELETE, payment POST/DELETE) go through the token api() client. The `api` URL
// prop is gone. Assets are tenant-scoped by the worker; no white-label hardcodes
// (the "Owed To" placeholder was neutralized from "Edgerton" to a generic label).

import { useState, useEffect } from 'react'
import { api as apiClient } from './api.js'

const ASSET_TYPES = ['Truck', 'Trailer', 'Refer Unit', 'Other Equipment']
const TYPE_ICONS = {
  'Truck':           '🚛',
  'Trailer':         '🚚',
  'Refer Unit':      '❄️',
  'Other Equipment': '⚙️',
}

export default function Assets({ driver, showToast, maintenanceEntries, role }) {
  const [assets,        setAssets]        = useState([])
  const [payments,      setPayments]      = useState({})
  const [loading,       setLoading]       = useState(true)
  const [showForm,      setShowForm]      = useState(false)
  const [editAsset,     setEditAsset]     = useState(null)
  const [expandedId,    setExpandedId]    = useState(null)
  const [confirmDel,    setConfirmDel]    = useState(null)
  const [deleting,      setDeleting]      = useState(false)
  const [saving,        setSaving]        = useState(false)
  const [showPayForm,   setShowPayForm]   = useState(null)
  const [confirmDelPay, setConfirmDelPay] = useState(null)

  const isBookkeeper = role === 'bookkeeper'

  const [form, setForm] = useState({
    asset_name: '', asset_type: 'Truck', year: '', make: '', model: '',
    vin_last6: '', notes: '', purchase_price: '', balance_owed: '',
    owed_to: '', purchase_date: '', estimated_value: '',
  })
  const [payForm, setPayForm] = useState({
    payment_date: new Date().toISOString().split('T')[0], amount: '', notes: '',
  })

  useEffect(() => { fetchAssets() }, [driver])

  async function fetchAssets() {
    setLoading(true)
    try {
      const data = await apiClient('/api/assets/' + driver)
      const list = Array.isArray(data) ? data : []
      setAssets(list)
      const payMap = {}
      await Promise.all(list.map(async a => {
        try {
          const d = await apiClient('/api/assets/' + a.id + '/payments')
          payMap[a.id] = Array.isArray(d) ? d : []
        } catch { payMap[a.id] = [] }
      }))
      setPayments(payMap)
    } catch (err) {
      console.error('Failed to load assets:', err)
    } finally {
      setLoading(false)
    }
  }

  function fmt(n) { return '$' + (parseFloat(n)||0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 }) }

  function repairsForAsset(assetId) {
    if (!maintenanceEntries) return 0
    return maintenanceEntries
      .filter(e => e.asset_id === assetId)
      .reduce((s,e) => s + (parseFloat(e.amount)||0), 0)
  }

  function totalPaidDown(assetId) {
    const list = payments[assetId] || []
    return list.reduce((s,p) => s + (parseFloat(p.amount)||0), 0)
  }

  function startAdd() {
    setForm({
      asset_name:'', asset_type:'Truck', year:'', make:'', model:'',
      vin_last6:'', notes:'', purchase_price:'', balance_owed:'',
      owed_to:'', purchase_date:'', estimated_value:'',
    })
    setEditAsset(null)
    setShowForm(true)
  }

  function startEdit(asset) {
    setForm({
      asset_name:      asset.asset_name      || '',
      asset_type:      asset.asset_type      || 'Truck',
      year:            asset.year            || '',
      make:            asset.make            || '',
      model:           asset.model           || '',
      vin_last6:       asset.vin_last6       || '',
      notes:           asset.notes           || '',
      purchase_price:  asset.purchase_price  || '',
      balance_owed:    asset.balance_owed    || '',
      owed_to:         asset.owed_to         || '',
      purchase_date:   asset.purchase_date   || '',
      estimated_value: asset.estimated_value || '',
    })
    setEditAsset(asset)
    setShowForm(true)
  }

  async function saveAsset() {
    if (!form.asset_name.trim()) { showToast('Enter an asset name'); return }
    setSaving(true)
    try {
      const body = {
        driver,
        asset_name:      form.asset_name.trim(),
        asset_type:      form.asset_type,
        year:            form.year,
        make:            form.make,
        model:           form.model,
        vin_last6:       form.vin_last6,
        notes:           form.notes,
        purchase_price:  parseFloat(form.purchase_price) || 0,
        balance_owed:    parseFloat(form.balance_owed)   || 0,
        owed_to:         form.owed_to,
        purchase_date:   form.purchase_date,
        estimated_value: parseFloat(form.estimated_value) || 0,
      }
      if (editAsset) {
        await apiClient('/api/assets/' + editAsset.id, { method: 'PATCH', json: body })
      } else {
        await apiClient('/api/assets', { method: 'POST', json: body })
      }
      showToast(editAsset ? '✅ Asset updated!' : '✅ Asset added!')
      setShowForm(false)
      setEditAsset(null)
      await fetchAssets()
    } catch (err) {
      showToast('⚠️ ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  async function deleteAsset(asset) {
    setDeleting(true)
    try {
      await apiClient('/api/assets/' + asset.id, { method: 'DELETE', json: { driver } })
      showToast('✅ Asset deleted')
      setConfirmDel(null)
      await fetchAssets()
    } catch (err) {
      showToast('⚠️ ' + err.message)
    } finally {
      setDeleting(false)
    }
  }

  async function savePayment(assetId) {
    if (!payForm.amount || parseFloat(payForm.amount) <= 0) { showToast('Enter a valid amount'); return }
    setSaving(true)
    try {
      await apiClient('/api/assets/' + assetId + '/payments', {
        method: 'POST',
        json: {
          driver,
          payment_date: payForm.payment_date,
          amount:       parseFloat(payForm.amount),
          notes:        payForm.notes,
        },
      })
      showToast('✅ Payment recorded!')
      setShowPayForm(null)
      setPayForm({ payment_date: new Date().toISOString().split('T')[0], amount: '', notes: '' })
      await fetchAssets()
    } catch (err) {
      showToast('⚠️ ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  async function deletePayment(assetId, payment) {
    try {
      await apiClient('/api/assets/' + assetId + '/payments/' + payment.id, {
        method: 'DELETE',
        json: { driver, amount: payment.amount },
      })
      showToast('✅ Payment removed')
      setConfirmDelPay(null)
      await fetchAssets()
    } catch (err) {
      showToast('⚠️ ' + err.message)
    }
  }

  if (loading) {
    return <div className="empty-state"><div className="icon">⚙️</div><h3>LOADING...</h3></div>
  }

  const totalPurchaseValue  = assets.reduce((s,a) => s + (parseFloat(a.purchase_price)||0), 0)
  const totalEstimatedValue = assets.reduce((s,a) => s + (parseFloat(a.estimated_value)||0), 0)
  const totalOwed           = assets.reduce((s,a) => s + (parseFloat(a.balance_owed)||0), 0)
  const totalRepairs        = assets.reduce((s,a) => s + repairsForAsset(a.id), 0)

  return (
    <div>

      {/* FLEET SUMMARY */}
      <div className="card" style={{ marginBottom:14 }}>
        <div className="section-title" style={{ marginBottom:8 }}>{driver} — EQUIPMENT ASSETS</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:8 }}>
          <div style={{ background:'var(--navy3)', borderRadius:8, padding:'10px 12px' }}>
            <div style={{ fontSize:10, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:4 }}>PURCHASE VALUE</div>
            <div style={{ fontFamily:'var(--font-head)', fontSize:16, fontWeight:900, color:'var(--amber)' }}>{fmt(totalPurchaseValue)}</div>
          </div>
          <div style={{ background:'var(--navy3)', borderRadius:8, padding:'10px 12px' }}>
            <div style={{ fontSize:10, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:4 }}>EST. CURRENT VALUE</div>
            <div style={{ fontFamily:'var(--font-head)', fontSize:16, fontWeight:900, color:'var(--green)' }}>{fmt(totalEstimatedValue)}</div>
          </div>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
          {/* Only show total owed to drivers, not bookkeeper */}
          {!isBookkeeper && (
            <div style={{ background:'#1a0a2a', borderRadius:8, padding:'10px 12px', border:'1px solid #7b1fa2' }}>
              <div style={{ fontSize:10, color:'#ce93d8', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:4 }}>TOTAL OWED</div>
              <div style={{ fontFamily:'var(--font-head)', fontSize:16, fontWeight:900, color:'#ce93d8' }}>{fmt(totalOwed)}</div>
            </div>
          )}
          <div style={{ background:'#2a0a0a', borderRadius:8, padding:'10px 12px', border:'1px solid #555', gridColumn: isBookkeeper ? 'span 2' : 'auto' }}>
            <div style={{ fontSize:10, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:4 }}>TOTAL REPAIRS</div>
            <div style={{ fontFamily:'var(--font-head)', fontSize:16, fontWeight:900, color:'#e53935' }}>{fmt(totalRepairs)}</div>
          </div>
        </div>
      </div>

      {/* ADD ASSET */}
      {!showForm && (
        <button className="scan-btn success" style={{ marginBottom:14 }} onClick={startAdd}>
          + ADD ASSET
        </button>
      )}

      {/* ASSET FORM */}
      {showForm && (
        <div className="card" style={{ marginBottom:14, border:'1px solid var(--amber)' }}>
          <div className="section-title" style={{ marginBottom:12 }}>
            {editAsset ? 'EDIT ASSET' : 'NEW ASSET'}
          </div>
          <div style={{ marginBottom:10 }}>
            <div className="field-label" style={{ marginBottom:6 }}>Asset Type</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
              {ASSET_TYPES.map(t => (
                <button key={t} onClick={() => setForm(p=>({...p, asset_type:t}))} style={{
                  padding:'10px 4px', borderRadius:8, border:'none',
                  background: form.asset_type === t ? 'var(--amber)' : 'var(--navy3)',
                  color: form.asset_type === t ? 'var(--navy)' : 'var(--grey)',
                  fontSize:12, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer',
                }}>
                  {TYPE_ICONS[t]} {t}
                </button>
              ))}
            </div>
          </div>
          <div className="field-row" style={{ marginBottom:10 }}>
            <div className="field-label">Asset Name</div>
            <input type="text" value={form.asset_name} onChange={e=>setForm(p=>({...p,asset_name:e.target.value}))}
              placeholder="e.g. Peterbilt 579, Utility Reefer Trailer"
              style={{ background:'var(--navy3)', border:'1px solid var(--border)', color:'var(--white)', borderRadius:8, padding:'10px 12px', fontSize:15, width:'100%', boxSizing:'border-box' }} />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, marginBottom:10 }}>
            <div>
              <div className="field-label" style={{ marginBottom:4 }}>Year</div>
              <input type="text" inputMode="numeric" value={form.year} onChange={e=>setForm(p=>({...p,year:e.target.value}))}
                placeholder="2014"
                style={{ background:'var(--navy3)', border:'1px solid var(--border)', color:'var(--white)', borderRadius:8, padding:'10px 8px', fontSize:14, width:'100%', boxSizing:'border-box' }} />
            </div>
            <div>
              <div className="field-label" style={{ marginBottom:4 }}>Make</div>
              <input type="text" value={form.make} onChange={e=>setForm(p=>({...p,make:e.target.value}))}
                placeholder="Peterbilt"
                style={{ background:'var(--navy3)', border:'1px solid var(--border)', color:'var(--white)', borderRadius:8, padding:'10px 8px', fontSize:14, width:'100%', boxSizing:'border-box' }} />
            </div>
            <div>
              <div className="field-label" style={{ marginBottom:4 }}>Model</div>
              <input type="text" value={form.model} onChange={e=>setForm(p=>({...p,model:e.target.value}))}
                placeholder="579"
                style={{ background:'var(--navy3)', border:'1px solid var(--border)', color:'var(--white)', borderRadius:8, padding:'10px 8px', fontSize:14, width:'100%', boxSizing:'border-box' }} />
            </div>
          </div>
          <div className="field-row" style={{ marginBottom:10 }}>
            <div className="field-label">VIN Last 6 Digits</div>
            <input type="text" value={form.vin_last6} onChange={e=>setForm(p=>({...p,vin_last6:e.target.value.toUpperCase()}))}
              placeholder="ED234685"
              style={{ background:'var(--navy3)', border:'1px solid var(--border)', color:'var(--white)', borderRadius:8, padding:'10px 12px', fontSize:15, fontFamily:'var(--font-head)', fontWeight:700, width:'100%', boxSizing:'border-box', letterSpacing:'0.1em' }} />
          </div>
          <div className="field-row" style={{ marginBottom:10 }}>
            <div className="field-label">Purchase Date</div>
            <input type="date" value={form.purchase_date} onChange={e=>setForm(p=>({...p,purchase_date:e.target.value}))}
              style={{ background:'var(--navy3)', border:'1px solid var(--border)', color:'var(--white)', borderRadius:8, padding:'10px 12px', fontSize:15, width:'100%', boxSizing:'border-box' }} />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:10 }}>
            <div>
              <div className="field-label" style={{ marginBottom:4 }}>Purchase Price ($)</div>
              <input type="text" inputMode="decimal" pattern="[0-9.]*" value={form.purchase_price}
                onChange={e=>setForm(p=>({...p,purchase_price:e.target.value}))} placeholder="0.00"
                style={{ background:'var(--navy3)', border:'1px solid var(--amber)', color:'var(--white)', borderRadius:8, padding:'10px 8px', fontSize:18, fontFamily:'var(--font-head)', fontWeight:700, width:'100%', boxSizing:'border-box' }} />
            </div>
            <div>
              <div className="field-label" style={{ marginBottom:4 }}>Est. Current Value ($)</div>
              <input type="text" inputMode="decimal" pattern="[0-9.]*" value={form.estimated_value}
                onChange={e=>setForm(p=>({...p,estimated_value:e.target.value}))} placeholder="0.00"
                style={{ background:'var(--navy3)', border:'1px solid var(--green)', color:'var(--white)', borderRadius:8, padding:'10px 8px', fontSize:18, fontFamily:'var(--font-head)', fontWeight:700, width:'100%', boxSizing:'border-box' }} />
            </div>
          </div>

          {/* Balance owed — only shown to drivers in form */}
          {!isBookkeeper && (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:10 }}>
              <div>
                <div className="field-label" style={{ marginBottom:4 }}>Balance Owed ($)</div>
                <input type="text" inputMode="decimal" pattern="[0-9.]*" value={form.balance_owed}
                  onChange={e=>setForm(p=>({...p,balance_owed:e.target.value}))} placeholder="0.00"
                  style={{ background:'var(--navy3)', border:'1px solid #ce93d8', color:'var(--white)', borderRadius:8, padding:'10px 8px', fontSize:18, fontFamily:'var(--font-head)', fontWeight:700, width:'100%', boxSizing:'border-box' }} />
              </div>
              <div>
                <div className="field-label" style={{ marginBottom:4 }}>Owed To</div>
                <input type="text" value={form.owed_to} onChange={e=>setForm(p=>({...p,owed_to:e.target.value}))}
                  placeholder="Lender name"
                  style={{ background:'var(--navy3)', border:'1px solid var(--border)', color:'var(--white)', borderRadius:8, padding:'10px 8px', fontSize:14, width:'100%', boxSizing:'border-box' }} />
              </div>
            </div>
          )}

          <div style={{ marginBottom:14 }}>
            <div className="field-label" style={{ marginBottom:4 }}>Condition Notes</div>
            <textarea value={form.notes} onChange={e=>setForm(p=>({...p,notes:e.target.value}))}
              placeholder="Pacar motor, mid roof sleeper, tires 80%, new water pump..."
              style={{ width:'100%', minHeight:80, background:'var(--navy3)', border:'1px solid var(--border)', color:'var(--white)', borderRadius:8, padding:'10px 12px', fontSize:14, fontFamily:'var(--font-body)', resize:'vertical', boxSizing:'border-box' }} />
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button disabled={saving} onClick={saveAsset} style={{
              flex:1, padding:'14px 0', borderRadius:8, border:'none',
              background: saving ? '#555' : 'var(--amber)', color:'var(--navy)',
              fontSize:15, fontFamily:'var(--font-head)', fontWeight:900, cursor:'pointer',
            }}>{saving ? 'SAVING...' : editAsset ? 'UPDATE ASSET' : 'SAVE ASSET'}</button>
            <button onClick={() => { setShowForm(false); setEditAsset(null) }} style={{
              flex:1, padding:'14px 0', borderRadius:8, border:'1px solid var(--border)',
              background:'transparent', color:'var(--grey)',
              fontSize:15, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer',
            }}>CANCEL</button>
          </div>
        </div>
      )}

      {assets.length === 0 && !showForm && (
        <div className="empty-state">
          <div className="icon">⚙️</div><h3>NO ASSETS YET</h3>
          <p>Tap + ADD ASSET to record your truck or trailer</p>
        </div>
      )}

      {/* ASSET CARDS */}
      {assets.map(asset => {
        const repairs       = repairsForAsset(asset.id)
        const paidDown      = totalPaidDown(asset.id)
        const balance       = parseFloat(asset.balance_owed) || 0
        const isExpanded    = expandedId === asset.id
        const assetPayments = payments[asset.id] || []
        const isPendingDel  = confirmDel === asset.id

        return (
          <div className="load-card" key={asset.id} style={{ borderLeft:'3px solid var(--amber)', marginBottom:12 }}>
            <div style={{ flex:1 }}>

              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
                <div style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:10, background:'var(--amber)', color:'var(--navy)', fontSize:10, fontFamily:'var(--font-head)', fontWeight:700 }}>
                  {TYPE_ICONS[asset.asset_type] || '⚙️'} {asset.asset_type}
                </div>
                {asset.purchase_date && (
                  <div style={{ fontSize:10, color:'var(--grey)' }}>
                    Purchased: {new Date(asset.purchase_date + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}
                  </div>
                )}
              </div>

              <div style={{ fontFamily:'var(--font-head)', fontSize:18, fontWeight:900, color:'var(--white)', marginBottom:2 }}>
                {asset.asset_name}
              </div>
              {(asset.year || asset.make || asset.model) && (
                <div style={{ fontSize:13, color:'var(--grey)', marginBottom:2 }}>
                  {[asset.year, asset.make, asset.model].filter(Boolean).join(' ')}
                </div>
              )}
              {asset.vin_last6 && (
                <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:8 }}>
                  VIN ...{asset.vin_last6}
                </div>
              )}

              {/* VALUE GRID */}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6, marginBottom:10 }}>
                <div style={{ background:'var(--navy3)', borderRadius:6, padding:'8px 8px' }}>
                  <div style={{ fontSize:9, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.06em', marginBottom:2 }}>PURCHASE</div>
                  <div style={{ fontFamily:'var(--font-head)', fontSize:13, fontWeight:900, color:'var(--amber)' }}>{fmt(asset.purchase_price)}</div>
                </div>
                <div style={{ background:'var(--navy3)', borderRadius:6, padding:'8px 8px' }}>
                  <div style={{ fontSize:9, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.06em', marginBottom:2 }}>EST. VALUE</div>
                  <div style={{ fontFamily:'var(--font-head)', fontSize:13, fontWeight:900, color:'var(--green)' }}>{fmt(asset.estimated_value)}</div>
                </div>
                <div style={{ background:'#2a0a0a', borderRadius:6, padding:'8px 8px', border:'1px solid #555' }}>
                  <div style={{ fontSize:9, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.06em', marginBottom:2 }}>REPAIRS</div>
                  <div style={{ fontFamily:'var(--font-head)', fontSize:13, fontWeight:900, color:'#e53935' }}>{fmt(repairs)}</div>
                </div>
              </div>

              {/* Balance owed — hidden from bookkeeper */}
              {!isBookkeeper && balance > 0 && (
                <div style={{ background:'#1a0a2a', border:'1px solid #7b1fa2', borderRadius:8, padding:'10px 12px', marginBottom:10 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4 }}>
                    <span style={{ fontSize:11, color:'#ce93d8', fontFamily:'var(--font-head)', fontWeight:700 }}>
                      BALANCE OWED {asset.owed_to ? 'TO ' + asset.owed_to.toUpperCase() : ''}
                    </span>
                    <span style={{ fontFamily:'var(--font-head)', fontSize:18, fontWeight:900, color:'#ce93d8' }}>{fmt(balance)}</span>
                  </div>
                  {paidDown > 0 && (
                    <div style={{ fontSize:11, color:'var(--green)', fontFamily:'var(--font-head)' }}>
                      Total paid down: {fmt(paidDown)}
                    </div>
                  )}
                </div>
              )}

              {asset.notes && (
                <div style={{ fontSize:12, color:'var(--grey)', marginBottom:10, lineHeight:1.5 }}>
                  {asset.notes}
                </div>
              )}

              {/* ACTION BUTTONS */}
              <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom: isExpanded ? 12 : 0 }}>
                {/* Payments button — hidden from bookkeeper */}
                {!isBookkeeper && (
                  <button onClick={() => setExpandedId(isExpanded ? null : asset.id)} style={{
                    flex:1, padding:'9px 0', borderRadius:8, border:'1px solid var(--border)',
                    background:'var(--navy3)', color:'var(--white)',
                    fontSize:12, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer',
                  }}>
                    {isExpanded ? '▲ HIDE PAYMENTS' : '💰 PAYMENTS (' + assetPayments.length + ')'}
                  </button>
                )}
                <button onClick={() => startEdit(asset)} style={{
                  flex:1, padding:'9px 0', borderRadius:8, border:'1px solid var(--border)',
                  background:'var(--navy3)', color:'var(--grey)',
                  fontSize:12, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer',
                }}>✏️ EDIT</button>
                {!isPendingDel && (
                  <button onClick={() => setConfirmDel(asset.id)} style={{
                    padding:'9px 12px', borderRadius:8, border:'1px solid #555',
                    background:'transparent', color:'#888',
                    fontSize:12, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer',
                  }}>DELETE</button>
                )}
              </div>

              {isPendingDel && (
                <div style={{ marginTop:8, background:'#2a0a0a', border:'1px solid #e53935', borderRadius:8, padding:'12px 14px' }}>
                  <div style={{ fontSize:12, color:'#e53935', fontFamily:'var(--font-head)', fontWeight:700, marginBottom:10 }}>
                    DELETE THIS ASSET? ALL PAYMENTS WILL ALSO BE DELETED.
                  </div>
                  <div style={{ display:'flex', gap:8 }}>
                    <button disabled={deleting} onClick={() => deleteAsset(asset)} style={{
                      flex:1, padding:'10px 0', borderRadius:8, border:'none',
                      background: deleting ? '#555' : '#e53935', color:'#fff',
                      fontSize:13, fontFamily:'var(--font-head)', fontWeight:900, cursor:'pointer',
                    }}>{deleting ? 'DELETING...' : 'CONFIRM DELETE'}</button>
                    <button disabled={deleting} onClick={() => setConfirmDel(null)} style={{
                      flex:1, padding:'10px 0', borderRadius:8, border:'1px solid #555',
                      background:'transparent', color:'#aaa',
                      fontSize:13, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer',
                    }}>CANCEL</button>
                  </div>
                </div>
              )}

              {/* PAYMENT SECTION — hidden from bookkeeper */}
              {!isBookkeeper && isExpanded && (
                <div style={{ borderTop:'1px solid var(--border)', paddingTop:12 }}>
                  <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:10 }}>
                    PAYMENT HISTORY
                  </div>
                  {showPayForm === asset.id ? (
                    <div style={{ background:'var(--navy3)', borderRadius:8, padding:'12px', marginBottom:10, border:'1px solid var(--amber)' }}>
                      <div style={{ fontSize:11, color:'var(--amber)', fontFamily:'var(--font-head)', fontWeight:700, marginBottom:10 }}>RECORD PAYMENT</div>
                      <div className="field-row" style={{ marginBottom:8 }}>
                        <div className="field-label">Date</div>
                        <input type="date" value={payForm.payment_date}
                          onChange={e=>setPayForm(p=>({...p,payment_date:e.target.value}))}
                          style={{ background:'var(--navy)', border:'1px solid var(--border)', color:'var(--white)', borderRadius:8, padding:'8px 10px', fontSize:14, width:'100%', boxSizing:'border-box' }} />
                      </div>
                      <div className="field-row" style={{ marginBottom:8 }}>
                        <div className="field-label">Amount ($)</div>
                        <input type="text" inputMode="decimal" pattern="[0-9.]*" value={payForm.amount}
                          onChange={e=>setPayForm(p=>({...p,amount:e.target.value}))} placeholder="0.00"
                          style={{ background:'var(--navy)', border:'1px solid var(--amber)', color:'var(--white)', borderRadius:8, padding:'8px 10px', fontSize:20, fontFamily:'var(--font-head)', fontWeight:700, width:'100%', boxSizing:'border-box' }} />
                      </div>
                      <div className="field-row" style={{ marginBottom:10 }}>
                        <div className="field-label">Notes (optional)</div>
                        <input type="text" value={payForm.notes}
                          onChange={e=>setPayForm(p=>({...p,notes:e.target.value}))} placeholder="e.g. Monthly installment"
                          style={{ background:'var(--navy)', border:'1px solid var(--border)', color:'var(--white)', borderRadius:8, padding:'8px 10px', fontSize:14, width:'100%', boxSizing:'border-box' }} />
                      </div>
                      <div style={{ display:'flex', gap:8 }}>
                        <button disabled={saving} onClick={() => savePayment(asset.id)} style={{
                          flex:1, padding:'10px 0', borderRadius:8, border:'none',
                          background: saving ? '#555' : 'var(--amber)', color:'var(--navy)',
                          fontSize:13, fontFamily:'var(--font-head)', fontWeight:900, cursor:'pointer',
                        }}>{saving ? 'SAVING...' : 'SAVE PAYMENT'}</button>
                        <button onClick={() => { setShowPayForm(null); setPayForm({ payment_date: new Date().toISOString().split('T')[0], amount:'', notes:'' }) }} style={{
                          flex:1, padding:'10px 0', borderRadius:8, border:'1px solid var(--border)',
                          background:'transparent', color:'var(--grey)',
                          fontSize:13, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer',
                        }}>CANCEL</button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => setShowPayForm(asset.id)} style={{
                      width:'100%', padding:'10px 0', borderRadius:8,
                      border:'1px solid var(--amber)', background:'transparent', color:'var(--amber)',
                      fontSize:12, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer', marginBottom:10,
                    }}>+ RECORD PAYMENT</button>
                  )}
                  {assetPayments.length === 0 && (
                    <div style={{ textAlign:'center', fontSize:12, color:'var(--grey)', padding:'10px 0' }}>No payments recorded yet</div>
                  )}
                  {assetPayments.map(pay => (
                    <div key={pay.id} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'8px 0', borderBottom:'1px solid var(--border)' }}>
                      <div>
                        <div style={{ fontSize:13, fontFamily:'var(--font-head)', fontWeight:700, color:'var(--green)' }}>{fmt(pay.amount)}</div>
                        <div style={{ fontSize:10, color:'var(--grey)', marginTop:2 }}>
                          {pay.payment_date ? new Date(pay.payment_date + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '-'}
                          {pay.notes ? ' — ' + pay.notes : ''}
                        </div>
                      </div>
                      {confirmDelPay === pay.id ? (
                        <div style={{ display:'flex', gap:6 }}>
                          <button onClick={() => deletePayment(asset.id, pay)} style={{ padding:'6px 10px', borderRadius:6, border:'none', background:'#e53935', color:'#fff', fontSize:11, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }}>DELETE</button>
                          <button onClick={() => setConfirmDelPay(null)} style={{ padding:'6px 10px', borderRadius:6, border:'1px solid #555', background:'transparent', color:'#aaa', fontSize:11, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }}>CANCEL</button>
                        </div>
                      ) : (
                        <button onClick={() => setConfirmDelPay(pay.id)} style={{ padding:'6px 10px', borderRadius:6, border:'1px solid #555', background:'transparent', color:'#888', fontSize:11, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }}>REMOVE</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
