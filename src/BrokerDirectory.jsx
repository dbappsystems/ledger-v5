// src/BrokerDirectory.jsx
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — Broker Master File
//
// AUTH MIGRATION: all 5 calls (list, loads report, PATCH, DELETE, POST) go
// through the token api() client. The `api` URL prop is gone. Brokers are
// tenant-scoped by the worker, so no white-label hardcodes here.

import { useState, useEffect } from 'react'
import { api as apiClient } from './api.js'

const PERIODS = [
  { key: 'week',  label: 'This Week' },
  { key: 'month', label: 'This Month' },
  { key: 'year',  label: 'This Year' },
  { key: 'all',   label: 'All Time' },
]

function fmt(n) {
  return '$' + (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const EMPTY_BROKER = {
  broker_name: '', broker_mc: '', broker_phone: '',
  broker_email: '', broker_contact: '', broker_address: '', notes: '',
}

export default function BrokerDirectory({ showToast, role }) {
  const [brokers,        setBrokers]        = useState([])
  const [loading,        setLoading]        = useState(true)
  const [search,         setSearch]         = useState('')
  const [selected,       setSelected]       = useState(null)   // broker object
  const [brokerLoads,    setBrokerLoads]    = useState([])
  const [reportStats,    setReportStats]    = useState({ totalLoads: 0, totalGross: 0 })
  const [period,         setPeriod]         = useState('month')
  const [loadingLoads,   setLoadingLoads]   = useState(false)
  const [editMode,       setEditMode]       = useState(false)
  const [editForm,       setEditForm]       = useState({})
  const [showAdd,        setShowAdd]        = useState(false)
  const [addForm,        setAddForm]        = useState(EMPTY_BROKER)
  const [saving,         setSaving]         = useState(false)
  const [confirmDelete,  setConfirmDelete]  = useState(false)

  const isBookkeeper = role === 'bookkeeper'

  useEffect(() => { fetchBrokers() }, [])

  useEffect(() => {
    if (selected) fetchBrokerLoads(selected.id, period)
  }, [selected, period])

  async function fetchBrokers() {
    setLoading(true)
    try {
      const data = await apiClient('/api/brokers')
      if (Array.isArray(data)) setBrokers(data)
    } catch {
      showToast('Could not load brokers')
    } finally {
      setLoading(false)
    }
  }

  async function fetchBrokerLoads(brokerId, p) {
    setLoadingLoads(true)
    try {
      const periodParam = p === 'all' ? '' : '?period=' + p
      const data = await apiClient('/api/brokers/' + brokerId + '/loads' + periodParam)
      setBrokerLoads(data.loads || [])
      setReportStats({ totalLoads: data.totalLoads || 0, totalGross: data.totalGross || 0 })
    } catch {
      showToast('Could not load broker loads')
    } finally {
      setLoadingLoads(false)
    }
  }

  function selectBroker(broker) {
    setSelected(broker)
    setEditMode(false)
    setEditForm({})
    setConfirmDelete(false)
  }

  function startEdit() {
    setEditForm({
      broker_name:    selected.broker_name    || '',
      broker_mc:      selected.broker_mc      || '',
      broker_phone:   selected.broker_phone   || '',
      broker_email:   selected.broker_email   || '',
      broker_contact: selected.broker_contact || '',
      broker_address: selected.broker_address || '',
      notes:          selected.notes          || '',
    })
    setEditMode(true)
  }

  async function saveEdit() {
    if (!editForm.broker_name || !editForm.broker_name.trim()) {
      showToast('Broker name is required')
      return
    }
    setSaving(true)
    try {
      const data = await apiClient('/api/brokers/' + selected.id, {
        method: 'PATCH',
        json: editForm,
      })
      if (data.ok) {
        showToast('Broker updated')
        const updated = { ...selected, ...editForm }
        setSelected(updated)
        setBrokers(prev => prev.map(b => b.id === selected.id ? updated : b))
        setEditMode(false)
      } else {
        showToast('Save failed: ' + (data.error || 'Unknown error'))
      }
    } catch {
      showToast('Connection error')
    } finally {
      setSaving(false)
    }
  }

  async function deleteBroker() {
    setSaving(true)
    try {
      const data = await apiClient('/api/brokers/' + selected.id, { method: 'DELETE' })
      if (data.ok) {
        showToast('Broker removed')
        setBrokers(prev => prev.filter(b => b.id !== selected.id))
        setSelected(null)
        setConfirmDelete(false)
      } else {
        showToast('Delete failed: ' + (data.error || 'Unknown error'))
      }
    } catch {
      showToast('Connection error')
    } finally {
      setSaving(false)
    }
  }

  async function addBroker() {
    if (!addForm.broker_name || !addForm.broker_name.trim()) {
      showToast('Broker name is required')
      return
    }
    setSaving(true)
    try {
      const data = await apiClient('/api/brokers', {
        method: 'POST',
        json: addForm,
      })
      if (data.id) {
        showToast(data.updated ? 'Broker updated' : 'Broker added')
        setAddForm(EMPTY_BROKER)
        setShowAdd(false)
        await fetchBrokers()
      } else {
        showToast('Failed: ' + (data.error || 'Unknown error'))
      }
    } catch {
      showToast('Connection error')
    } finally {
      setSaving(false)
    }
  }

  const filtered = brokers.filter(b =>
    !search || b.broker_name.toLowerCase().includes(search.toLowerCase())
  )

  // ── DETAIL VIEW ──────────────────────────────────────────
  if (selected) {
    const b = selected
    return (
      <div>
        {/* Back button */}
        <button
          onClick={() => { setSelected(null); setEditMode(false); setConfirmDelete(false) }}
          style={{ display:'flex', alignItems:'center', gap:6, background:'transparent', border:'none', color:'var(--amber)', fontFamily:'var(--font-head)', fontSize:13, fontWeight:700, letterSpacing:'0.08em', cursor:'pointer', padding:'0 0 16px 0' }}
        >
          ← ALL BROKERS
        </button>

        {/* Contact Card */}
        <div className="card">
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:14 }}>
            <div className="section-title" style={{ margin:0 }}>BROKER PROFILE</div>
            {!editMode && !confirmDelete && (
              <button onClick={startEdit} style={{ padding:'6px 14px', borderRadius:8, border:'1px solid var(--amber)', background:'transparent', color:'var(--amber)', fontSize:11, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }}>
                EDIT
              </button>
            )}
          </div>

          {!editMode ? (
            <div>
              <div style={{ fontSize:20, fontFamily:'var(--font-head)', fontWeight:900, color:'var(--white)', marginBottom:16 }}>
                {b.broker_name}
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:16 }}>
                <InfoRow label="MC #"        value={b.broker_mc      || '—'} />
                <InfoRow label="Contact"     value={b.broker_contact || '—'} />
                <InfoRow label="Phone"       value={b.broker_phone   || '—'} link={b.broker_phone ? 'tel:' + b.broker_phone : null} />
                <InfoRow label="Email"       value={b.broker_email   || '—'} link={b.broker_email ? 'mailto:' + b.broker_email : null} />
                <InfoRow label="Address"     value={b.broker_address || '—'} style={{ gridColumn:'1 / -1' }} />
                {b.notes && <InfoRow label="Notes" value={b.notes} style={{ gridColumn:'1 / -1' }} />}
              </div>

              {!confirmDelete && (
                <button
                  onClick={() => setConfirmDelete(true)}
                  style={{ width:'100%', padding:'11px 0', borderRadius:8, border:'1px solid #e53935', background:'transparent', color:'#e53935', fontSize:12, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }}
                >
                  REMOVE BROKER
                </button>
              )}
              {confirmDelete && (
                <div style={{ background:'#2a0a0a', border:'1px solid #e53935', borderRadius:10, padding:16 }}>
                  <div style={{ fontSize:13, color:'#e53935', fontFamily:'var(--font-head)', fontWeight:700, marginBottom:12 }}>
                    Remove {b.broker_name}? This will not delete their load history.
                  </div>
                  <div style={{ display:'flex', gap:8 }}>
                    <button onClick={deleteBroker} disabled={saving} style={{ flex:1, padding:'12px 0', borderRadius:8, border:'none', background:'#e53935', color:'#fff', fontSize:13, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }}>
                      {saving ? 'REMOVING...' : 'YES, REMOVE'}
                    </button>
                    <button onClick={() => setConfirmDelete(false)} style={{ flex:1, padding:'12px 0', borderRadius:8, border:'1px solid var(--border)', background:'transparent', color:'var(--grey)', fontSize:13, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }}>
                      CANCEL
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div>
              <EditField label="Broker Name *"   value={editForm.broker_name}    onChange={v => setEditForm(f => ({ ...f, broker_name: v }))} />
              <EditField label="MC #"             value={editForm.broker_mc}      onChange={v => setEditForm(f => ({ ...f, broker_mc: v }))} />
              <EditField label="Contact Person"   value={editForm.broker_contact} onChange={v => setEditForm(f => ({ ...f, broker_contact: v }))} />
              <EditField label="Phone"            value={editForm.broker_phone}   onChange={v => setEditForm(f => ({ ...f, broker_phone: v }))} type="tel" />
              <EditField label="Email"            value={editForm.broker_email}   onChange={v => setEditForm(f => ({ ...f, broker_email: v }))} type="email" />
              <EditField label="Address"          value={editForm.broker_address} onChange={v => setEditForm(f => ({ ...f, broker_address: v }))} />
              <EditField label="Notes"            value={editForm.notes}          onChange={v => setEditForm(f => ({ ...f, notes: v }))} multiline />
              <div style={{ display:'flex', gap:8, marginTop:6 }}>
                <button onClick={saveEdit} disabled={saving} style={{ flex:1, padding:'13px 0', borderRadius:8, border:'none', background:saving ? '#555' : 'var(--amber)', color:'#0A1628', fontSize:13, fontFamily:'var(--font-head)', fontWeight:900, cursor:'pointer' }}>
                  {saving ? 'SAVING...' : 'SAVE CHANGES'}
                </button>
                <button onClick={() => setEditMode(false)} style={{ flex:1, padding:'13px 0', borderRadius:8, border:'1px solid var(--border)', background:'transparent', color:'var(--grey)', fontSize:13, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }}>
                  CANCEL
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Freight Report */}
        <div className="card">
          <div className="section-title">FREIGHT REPORT</div>

          {/* Period Selector */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:6, marginBottom:16 }}>
            {PERIODS.map(p => (
              <button key={p.key} onClick={() => setPeriod(p.key)} style={{
                padding:'9px 0', borderRadius:8, border:'1px solid',
                borderColor: period === p.key ? 'var(--amber)' : 'var(--border)',
                background:  period === p.key ? 'rgba(245,166,35,0.12)' : 'var(--navy3)',
                color:       period === p.key ? 'var(--amber)' : 'var(--grey)',
                fontSize:10, fontFamily:'var(--font-head)', fontWeight:700,
                letterSpacing:'0.04em', cursor:'pointer',
              }}>
                {p.label.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Stats Row */}
          {loadingLoads ? (
            <div style={{ textAlign:'center', padding:24, color:'var(--grey)', fontSize:13 }}>Loading...</div>
          ) : (
            <>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:16 }}>
                <div style={{ background:'var(--navy3)', borderRadius:10, padding:14, textAlign:'center' }}>
                  <div style={{ fontSize:28, fontFamily:'var(--font-head)', color:'var(--amber)', lineHeight:1 }}>
                    {reportStats.totalLoads}
                  </div>
                  <div style={{ fontSize:10, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginTop:4 }}>
                    LOADS
                  </div>
                </div>
                <div style={{ background:'var(--navy3)', borderRadius:10, padding:14, textAlign:'center' }}>
                  <div style={{ fontSize:22, fontFamily:'var(--font-head)', color:'var(--amber)', lineHeight:1 }}>
                    {fmt(reportStats.totalGross)}
                  </div>
                  <div style={{ fontSize:10, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginTop:4 }}>
                    GROSS REVENUE
                  </div>
                </div>
              </div>

              {/* Load List */}
              {brokerLoads.length === 0 ? (
                <div style={{ textAlign:'center', padding:16, color:'var(--grey)', fontSize:13 }}>
                  No loads for this period
                </div>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  {brokerLoads.map(load => (
                    <div key={load.id} style={{ background:'var(--navy3)', borderRadius:10, padding:12, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                      <div>
                        <div style={{ fontSize:13, fontWeight:600, color:'var(--white)' }}>
                          {load.origin} → {load.destination}
                        </div>
                        <div style={{ fontSize:11, color:'var(--grey)', marginTop:2 }}>
                          {load.driver} · {load.delivery_date || load.pickup_date || '—'} · #{load.load_number || '—'}
                        </div>
                      </div>
                      <div style={{ textAlign:'right', flexShrink:0 }}>
                        <div style={{ fontSize:14, fontFamily:'var(--font-head)', color:'var(--amber)', fontWeight:700 }}>
                          {fmt(load.base_pay)}
                        </div>
                        <div style={{ fontSize:10, color: load.status === 'paid' ? '#2ECC71' : 'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.06em', marginTop:2 }}>
                          {(load.status || 'invoiced').toUpperCase()}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  // ── ADD BROKER FORM ──────────────────────────────────────
  if (showAdd) {
    return (
      <div>
        <button
          onClick={() => { setShowAdd(false); setAddForm(EMPTY_BROKER) }}
          style={{ display:'flex', alignItems:'center', gap:6, background:'transparent', border:'none', color:'var(--amber)', fontFamily:'var(--font-head)', fontSize:13, fontWeight:700, letterSpacing:'0.08em', cursor:'pointer', padding:'0 0 16px 0' }}
        >
          ← BACK
        </button>
        <div className="card">
          <div className="section-title">ADD BROKER</div>
          <EditField label="Broker Name *"   value={addForm.broker_name}    onChange={v => setAddForm(f => ({ ...f, broker_name: v }))} />
          <EditField label="MC #"             value={addForm.broker_mc}      onChange={v => setAddForm(f => ({ ...f, broker_mc: v }))} />
          <EditField label="Contact Person"   value={addForm.broker_contact} onChange={v => setAddForm(f => ({ ...f, broker_contact: v }))} />
          <EditField label="Phone"            value={addForm.broker_phone}   onChange={v => setAddForm(f => ({ ...f, broker_phone: v }))} type="tel" />
          <EditField label="Email"            value={addForm.broker_email}   onChange={v => setAddForm(f => ({ ...f, broker_email: v }))} type="email" />
          <EditField label="Address"          value={addForm.broker_address} onChange={v => setAddForm(f => ({ ...f, broker_address: v }))} />
          <EditField label="Notes"            value={addForm.notes}          onChange={v => setAddForm(f => ({ ...f, notes: v }))} multiline />
          <div style={{ display:'flex', gap:8, marginTop:6 }}>
            <button onClick={addBroker} disabled={saving} style={{ flex:1, padding:'13px 0', borderRadius:8, border:'none', background:saving ? '#555' : 'var(--amber)', color:'#0A1628', fontSize:14, fontFamily:'var(--font-head)', fontWeight:900, cursor:'pointer' }}>
              {saving ? 'SAVING...' : 'ADD BROKER'}
            </button>
            <button onClick={() => { setShowAdd(false); setAddForm(EMPTY_BROKER) }} style={{ flex:1, padding:'13px 0', borderRadius:8, border:'1px solid var(--border)', background:'transparent', color:'var(--grey)', fontSize:13, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }}>
              CANCEL
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── LIST VIEW ────────────────────────────────────────────
  return (
    <div>
      {/* Header row */}
      <div style={{ display:'flex', gap:8, marginBottom:14, alignItems:'center' }}>
        <input
          placeholder="Search brokers..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex:1 }}
        />
        <button onClick={() => setShowAdd(true)} style={{ padding:'12px 16px', borderRadius:10, border:'none', background:'var(--amber)', color:'#0A1628', fontSize:12, fontFamily:'var(--font-head)', fontWeight:900, cursor:'pointer', whiteSpace:'nowrap' }}>
          + ADD
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign:'center', padding:40, color:'var(--grey)', fontSize:13 }}>Loading brokers...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign:'center', padding:40, color:'var(--grey)', fontSize:13 }}>
          {search ? 'No brokers match your search' : 'No brokers yet — they will appear automatically as you scan rate cons'}
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {filtered.map(b => (
            <button
              key={b.id}
              onClick={() => selectBroker(b)}
              style={{ width:'100%', textAlign:'left', background:'var(--navy2)', border:'1px solid var(--border)', borderRadius:12, padding:16, cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center' }}
            >
              <div>
                <div style={{ fontSize:15, fontWeight:600, color:'var(--white)', marginBottom:4 }}>
                  {b.broker_name}
                </div>
                <div style={{ fontSize:11, color:'var(--grey)', display:'flex', gap:10, flexWrap:'wrap' }}>
                  {b.broker_mc      && <span>MC #{b.broker_mc}</span>}
                  {b.broker_contact && <span>{b.broker_contact}</span>}
                  {b.broker_phone   && <span>{b.broker_phone}</span>}
                  {!b.broker_mc && !b.broker_contact && !b.broker_phone && <span>No contact info yet</span>}
                </div>
              </div>
              <div style={{ fontSize:18, color:'var(--amber)', flexShrink:0, marginLeft:8 }}>›</div>
            </button>
          ))}
        </div>
      )}

      {brokers.length > 0 && (
        <div style={{ textAlign:'center', fontSize:11, color:'var(--grey)', marginTop:20, fontFamily:'var(--font-head)', letterSpacing:'0.06em' }}>
          {brokers.length} BROKER{brokers.length !== 1 ? 'S' : ''} ON FILE
        </div>
      )}
    </div>
  )
}

// ── SUB-COMPONENTS ───────────────────────────────────────────
function InfoRow({ label, value, link, style: extraStyle }) {
  return (
    <div style={{ ...extraStyle }}>
      <div style={{ fontSize:10, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.08em', marginBottom:3 }}>
        {label}
      </div>
      {link ? (
        <a href={link} style={{ fontSize:13, color:'var(--amber)', textDecoration:'none', fontWeight:600 }}>
          {value}
        </a>
      ) : (
        <div style={{ fontSize:13, color:'var(--white)', fontWeight:500 }}>{value}</div>
      )}
    </div>
  )
}

function EditField({ label, value, onChange, type, multiline }) {
  return (
    <div className="field-row">
      <div className="field-label">{label}</div>
      {multiline ? (
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          rows={3}
          style={{ width:'100%', background:'var(--navy3)', border:'1px solid var(--border)', borderRadius:8, color:'var(--white)', padding:'10px 12px', fontSize:15, fontFamily:'var(--font-body)', resize:'vertical', boxSizing:'border-box' }}
        />
      ) : (
        <input
          type={type || 'text'}
          value={value}
          onChange={e => onChange(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
        />
      )}
    </div>
  )
}
