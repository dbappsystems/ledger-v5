// src/App.jsx
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledgers V5 — auth wired to src/api.js (token-based, tenant-aware).
//
// AUTH MIGRATION (complete): every child now imports the api() token client
// directly, so the dead `api={API}` URL prop has been stripped from all of them,
// the `API`/`API_BASE` plumbing is gone, and the obsolete `pin` prop (v4 PIN auth)
// is removed. The per-tenant split (tenantSettings.driver_split_pct) is threaded
// as `ownerCutPct` into the components that do settlement math.
//
// WHITE-LABEL: the bookkeeper VIEWING bar now reads the tenant's own drivers via
// useDrivers() (GET /api/drivers, falls back to BRUCE/TIM). Header/logo read
// tenantSettings.display_name. Maintenance receives tenantSettings so its
// financing labels read the tenant's company name (not hardcoded ETTR).
//
// BRANDING: product wordmark is lowercase "loadledgers" (one word) with a small
// "v5" beside it, shown when no tenant display_name is set. A real tenant shows
// THEIR company name (uppercased as their brand), no version marker.
//
// FEEDBACK: a floating in-app feedback bubble (<Feedback/>) is rendered only in
// the logged-in app (never on the login screen). It posts comments to the DB
// (POST /api/contact) — it does NOT send email. It floats above the tab bar.
//
// RATE CON QUEUE (2026-07-05): rate cons rest in their own screen
// (RateConQueue.jsx), mounted as loadsSubView 'ratecon-queue' (driver only).
// The scan page reaches it via its 📥 QUEUE button (onOpenQueue); the queue's
// ← BACK returns to the scan page. On the queue, tapping OPEN stashes the con
// in pendingScanRc and switches to the scan page, which auto-scans it via the
// SAME scanner and links it off the queue. onPendingScanDone clears the stash.
//
// OWNER VISIBILITY (2026-07-05): role 'owner' (the carrier) now gets the same
// VIEWING driver selector the bookkeeper uses — on Repairs and Assets AND on
// the Profile tab — so the owner can open any driver's Settlement Reports,
// IFTA card, Tax Desk, credentials, repairs, and assets. The driver-keyed
// desks read activeDriver, which falls back to self until the tenant driver
// list loads, so nothing ever renders with a null driver. A plain 'driver'
// role is untouched: activeDriver === driver for them, exactly as before.
//
// LIVE STATE MILES (2026-07-07): a LOG STATE MILES button (IftaDailyLog.jsx) is
// rendered for drivers on the Loads pages. It logs the driver's own odometer at
// each state line (raw daily chain) via POST /api/ifta/manual, writing the FACT
// record beside the routed IFTA estimate. Placed inline in the header (centered
// over the LOADS area) via IftaDailyLog's `inline` prop.

import { useState, useEffect } from 'react'
import RateCon          from './RateCon.jsx'
import RateConQueue     from './RateConQueue.jsx'
import Invoice          from './Invoice.jsx'
import Loads            from './Loads.jsx'
import DriverProfile    from './DriverProfile.jsx'
import Maintenance      from './Maintenance.jsx'
import Assets           from './Assets.jsx'
import Tax              from './Tax.jsx'
import IftaEstimate     from './IftaEstimate.jsx'
import IftaReport       from './IftaReport.jsx'
import SettlementReport from './SettlementReport.jsx'
import BookkeeperProfile from './BookkeeperProfile.jsx'
import Feedback         from './Feedback.jsx'
import IftaDailyLog     from './IftaDailyLog.jsx'
import { useDrivers }   from './useDrivers.js'

import { api, login as apiLogin, logout as apiLogout, getSession } from './api.js'

const CRED_LABELS = {
  dot_physical:    'DOT Physical',
  drivers_license: "Driver's License",
  cab_card:        'Cab Card',
  plates:          'Truck Plates',
  authority:       'Authority (MC#)',
  insurance:       'Insurance',
  heavy_use_tax:   'Heavy Use Tax',
}

function daysUntil(dateStr) {
  if (!dateStr) return null
  const exp = new Date(dateStr), now = new Date()
  now.setHours(0,0,0,0); exp.setHours(0,0,0,0)
  return Math.ceil((exp - now) / (1000 * 60 * 60 * 24))
}

export default function App() {
  const [tab,             setTab]             = useState('loads')
  const [loadsSubView,    setLoadsSubView]    = useState('list')
  const [driver,          setDriver]          = useState(null)
  const [role,            setRole]            = useState(null)
  const [viewDriver,      setViewDriver]      = useState(null)
  const [load,            setLoad]            = useState(newLoad())
  const [loads,           setLoads]           = useState([])
  const [toast,           setToast]           = useState(null)
  const [tenantSettings,  setTenantSettings]  = useState(null)

  // RATE CON QUEUE: a con handed from the queue's OPEN button, waiting for the
  // scan page to pick it up and run the scanner on it. Cleared once scanned.
  const [pendingScanRc,   setPendingScanRc]   = useState(null)

  // WHITE-LABEL: the tenant's own drivers (names + colors), replacing the old
  // hardcoded ['BRUCE','TIM']. Falls back to the seeded identities if the
  // /api/drivers call is unavailable, so behavior never regresses.
  const { names: driverNames } = useDrivers()

  // Default the bookkeeper "viewing" driver to the tenant's first driver once
  // the list is known. Keeps working if the list changes between tenants.
  useEffect(() => {
    if (viewDriver == null && driverNames.length > 0) setViewDriver(driverNames[0])
  }, [driverNames, viewDriver])

  // Per-tenant owner/company split (whole-number %, 1..50). Defaults to 10
  // until tenant settings load — keeps Edgerton's historical 90/10 unchanged.
  const ownerCutPct = (tenantSettings && tenantSettings.driver_split_pct != null)
    ? tenantSettings.driver_split_pct
    : 10

  const [lightMode, setLightMode] = useState(() => {
    return localStorage.getItem('ll_v4_theme') === 'light'
  })

  useEffect(() => {
    if (lightMode) {
      document.body.classList.add('light')
      localStorage.setItem('ll_v4_theme', 'light')
    } else {
      document.body.classList.remove('light')
      localStorage.setItem('ll_v4_theme', 'dark')
    }
  }, [lightMode])

  const [email,        setEmail]        = useState('')
  const [password,     setPassword]     = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginError,   setLoginError]   = useState('')

  const [maintenanceEntries, setMaintenanceEntries] = useState([])
  const [credAlerts,         setCredAlerts]         = useState([])
  const [alertIdx,           setAlertIdx]           = useState(0)
  const [snoozeInput,        setSnoozeInput]        = useState('')
  const [showSnooze,         setShowSnooze]         = useState(false)

  useEffect(() => {
    try {
      const session = getSession()   // token-based session from src/api.js
      if (session && session.token) {
        setDriver(session.driver_name)
        setRole(session.role)
        if (session.tenant_id) loadTenantSettings()
        if (session.role === 'driver') {
          setTab('loads')
          setLoadsSubView('ratecon')
        } else {
          setTab('loads')
          setLoadsSubView('list')
        }
      }
    } catch {}
  }, [])

  const isBookkeeper = role === 'bookkeeper'
  // OWNER VISIBILITY: the carrier owner can repoint the driver-keyed desks
  // (Settlement, IFTA, Tax, Repairs, Assets, DriverProfile) at any tenant
  // driver via the same VIEWING selector the bookkeeper already uses.
  // activeDriver falls back to self until the driver list loads, so the
  // desks never render with a null driver.
  const isOwner    = role === 'owner'
  const canViewAll = isBookkeeper || isOwner
  const activeDriver = canViewAll ? (viewDriver || driver) : driver

  // BOOK NOW, BILL LATER: a booked load is a contract, not earnings. Every
  // settlement, tax, and bookkeeper input gets this filtered list so booked
  // rows can never move money math until they are invoiced. The Loads list
  // itself still shows booked cards (teal chip) so nothing is hidden.
  const billableLoads = loads.filter(l => l.status !== 'booked')

  async function fetchLoads() {
    try {
      const data = await api('/api/loads')
      if (Array.isArray(data)) {
        setLoads(data)
        try { localStorage.setItem('ll_v5_loads', JSON.stringify(data)) } catch {}
      }
    } catch {
      try {
        const saved = localStorage.getItem('ll_v5_loads')
        if (saved) setLoads(JSON.parse(saved))
      } catch {}
    }
  }

  // Load this tenant's white-label settings (split %, branding) after login.
  async function loadTenantSettings() {
    try {
      const s = await api('/api/tenant/settings')
      if (s && !s.error) setTenantSettings(s)
    } catch { /* non-fatal; app still works with defaults */ }
  }

  // CARRIER RATE TOGGLE: the owner sets the company-keep % (driver_split_pct)
  // straight from the header. Writes the ONE tenant value via the owner-only
  // PATCH /api/tenant/settings (worker clamps 1..50), then refreshes
  // tenantSettings in place so every settlement + paystub recomputes at the new
  // rate immediately — the same all-time running-balance math, new percentage.
  // Owner-only by construction: the control is not rendered for driver or
  // bookkeeper, and the worker rejects the PATCH for any non-owner role.
  const [savingSplit, setSavingSplit] = useState(false)
  async function saveSplitPct(pct) {
    if (savingSplit) return
    const current = (tenantSettings && tenantSettings.driver_split_pct != null)
      ? Number(tenantSettings.driver_split_pct) : 10
    if (Number(pct) === current) return
    setSavingSplit(true)
    try {
      await api('/api/tenant/settings', { method:'PATCH', json:{ driver_split_pct: Number(pct) } })
      await loadTenantSettings()   // re-read the row so all math sees the new %
      showToast('Carrier rate set to ' + pct + '%')
    } catch (e) {
      showToast(e && e.message ? e.message : 'Could not update rate')
    } finally {
      setSavingSplit(false)
    }
  }

  async function checkCredentials(driverName) {
    try {
      const data  = await api('/api/credentials/' + driverName)
      const today = new Date().toISOString().split('T')[0]
      const alerts = []
      Object.keys(CRED_LABELS).forEach(key => {
        const expDate    = data[key] || ''
        const snoozeDate = data[key + '_snooze'] || ''
        const days       = daysUntil(expDate)
        if (snoozeDate && snoozeDate > today) return
        if (days !== null && days <= 30) alerts.push({ key, label: CRED_LABELS[key], days, expDate })
        if (!expDate) alerts.push({ key, label: CRED_LABELS[key], days: null, expDate: '' })
      })
      if (alerts.length > 0) {
        setCredAlerts(alerts); setAlertIdx(0); setShowSnooze(false); setSnoozeInput('')
      }
    } catch (err) { console.error('Failed to check credentials:', err) }
  }

  useEffect(() => {
    if (!driver) return
    fetchLoads()
    if (role === 'driver') checkCredentials(driver)
  }, [driver])

  async function handleLogin() {
    if (!email.trim() || !password.trim()) {
      setLoginError('Please enter your email and password')
      return
    }
    setLoginLoading(true)
    setLoginError('')
    try {
      const result = await apiLogin(email.trim().toLowerCase(), password)
      if (result.ok) {
        // api client already stored token + tenant_id + driver + role.
        setDriver(result.driver_name)
        setRole(result.role)
        setEmail('')
        setPassword('')
        setLoginError('')
        loadTenantSettings()   // fetch this tenant's split + branding
        if (result.role === 'driver') {
          setTab('loads')
          setLoadsSubView('ratecon')
        } else {
          setTab('loads')
          setLoadsSubView('list')
        }
      } else {
        setLoginError(result.error || 'Invalid email or password')
      }
    } catch {
      setLoginError('Connection error - try again')
    } finally {
      setLoginLoading(false)
    }
  }

  function newLoad() {
    return {
      id: null, broker_name: '', broker_email: '', load_number: '',
      origin: '', destination: '', pickup_date: '', delivery_date: '',
      base_pay: '', bols: [], lumpers: [], incidentals: [], comdatas: [],
      detention: '', pallets: '', notes: '', status: 'draft',
      // Multi-stop IFTA: filled by the rate con scan (RateCon.jsx), saved to
      // load_stops by Invoice.jsx STEP 1b. Explicit here so a new load never
      // carries the previous scan's stops.
      stops: [],
      // BOOK NOW, BILL LATER: rc_pages carries the scanned rate con page bytes
      // so the RC PDF can be stored to R2 (at booking, or at billing via
      // Invoice.jsx STEP 1c). booked_id is set only when billing a previously
      // booked load — Invoice.jsx then PATCHes that row instead of inserting.
      // Explicit here so a new load never carries the previous load's pages.
      rc_pages: [],
      booked_id: null,
    }
  }

  function showToast(msg) { setToast(msg); setTimeout(() => setToast(null), 3000) }

  function resetLoad() {
    setLoad(newLoad())
    setTab('loads')
    setLoadsSubView('ratecon')
  }

  function afterInvoiceSave() {
    setLoad(newLoad())
    setLoadsSubView('list')
  }

  // RATE CON QUEUE: OPEN on the queue hands a con here. Start from a clean load
  // (a queued con is a NEW load, never a booked pickup), stash the con, and
  // switch to the scan page — its pendingScanRc effect runs the scanner.
  function scanQueuedRc(rc) {
    setLoad(newLoad())
    setPendingScanRc(rc)
    setLoadsSubView('ratecon')
  }

  function logout() {
    apiLogout()              // clears the v5 session token + tells the worker
    setDriver(null)
    setRole(null)
    setTenantSettings(null)
    setEmail('')
    setPassword('')
    setLoginError('')
    setLoad(newLoad())
    setLoads([])
    setCredAlerts([])
    setMaintenanceEntries([])
    setPendingScanRc(null)
    setTab('loads')
    setLoadsSubView('list')
  }

  const currentAlert = credAlerts[alertIdx] || null

  function dismissAlert() {
    const next = alertIdx + 1
    if (next >= credAlerts.length) { setCredAlerts([]); setAlertIdx(0) }
    else { setAlertIdx(next) }
    setShowSnooze(false); setSnoozeInput('')
  }

  async function snoozeAlert() {
    if (!snoozeInput || !currentAlert) return
    try {
      const data = await api('/api/credentials/' + driver)
      await api('/api/credentials/' + driver, {
        method: 'PATCH',
        json:   { ...data, [currentAlert.key + '_snooze']: snoozeInput },
      })
    } catch {}
    dismissAlert()
  }

  function renderCredAlert() {
    if (!currentAlert || !driver || role !== 'driver') return null
    const { label, days, expDate } = currentAlert
    const isExpired   = days !== null && days < 0
    const isUnset     = days === null
    const isSoon      = days !== null && days >= 0 && days <= 30
    const borderColor = isExpired ? '#e53935' : '#ffb300'
    const titleColor  = isExpired ? '#e53935' : '#ffb300'
    return (
      <div style={{ position:'fixed', top:0, left:0, right:0, bottom:0, background:'rgba(0,0,0,0.85)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:24 }}>
        <div style={{ background: isExpired ? '#2a0a0a' : '#1a1200', border:'2px solid '+borderColor, borderRadius:14, padding:24, width:'100%', maxWidth:360 }}>
          <div style={{ fontSize:13, color:titleColor, fontFamily:'var(--font-head)', fontWeight:900, letterSpacing:'0.1em', marginBottom:8 }}>CREDENTIAL ALERT</div>
          <div style={{ fontSize:20, fontFamily:'var(--font-head)', fontWeight:900, color:'#fff', marginBottom:8 }}>{label}</div>
          <div style={{ fontSize:14, color:titleColor, fontFamily:'var(--font-head)', fontWeight:700, marginBottom:16 }}>
            {isUnset   && 'No expiration date on file. Please update.'}
            {isExpired && 'EXPIRED ' + Math.abs(days) + ' days ago!'}
            {isSoon    && (days === 0 ? 'EXPIRES TODAY!' : 'Expires in ' + days + ' day' + (days !== 1 ? 's' : '') + '!')}
          </div>
          {expDate && (
            <div style={{ fontSize:11, color:'#aaa', marginBottom:16 }}>
              Current expiration: {new Date(expDate + 'T12:00:00').toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })}
            </div>
          )}
          {credAlerts.length > 1 && (
            <div style={{ fontSize:11, color:'#aaa', marginBottom:16 }}>Alert {alertIdx+1} of {credAlerts.length}</div>
          )}
          {!showSnooze ? (
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              <button onClick={() => { dismissAlert(); setTab('profile') }} style={{ padding:'14px 0', borderRadius:8, border:'none', background:'var(--amber)', color:'#0A1628', fontSize:14, fontFamily:'var(--font-head)', fontWeight:900, cursor:'pointer' }}>UPDATE NOW</button>
              <button onClick={() => setShowSnooze(true)} style={{ padding:'12px 0', borderRadius:8, border:'1px solid #555', background:'transparent', color:'#aaa', fontSize:13, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }}>REMIND ME ON A SPECIFIC DATE</button>
              <button onClick={dismissAlert} style={{ padding:'12px 0', borderRadius:8, border:'1px solid #333', background:'transparent', color:'#666', fontSize:12, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }}>OK - DISMISS FOR NOW</button>
            </div>
          ) : (
            <div>
              <div style={{ fontSize:11, color:'#aaa', fontFamily:'var(--font-head)', letterSpacing:'0.06em', marginBottom:8 }}>REMIND ME ON THIS DATE</div>
              <input type="date" value={snoozeInput} onChange={e => setSnoozeInput(e.target.value)}
                style={{ width:'100%', background:'#1A3A5C', border:'1px solid var(--amber)', color:'#fff', borderRadius:8, padding:'12px 14px', fontSize:16, fontFamily:'var(--font-body)', marginBottom:10, boxSizing:'border-box' }} />
              <div style={{ display:'flex', gap:8 }}>
                <button disabled={!snoozeInput} onClick={snoozeAlert} style={{ flex:1, padding:'12px 0', borderRadius:8, border:'none', background: snoozeInput ? 'var(--amber)' : '#555', color:'#0A1628', fontSize:13, fontFamily:'var(--font-head)', fontWeight:900, cursor:'pointer' }}>SET REMINDER</button>
                <button onClick={() => { setShowSnooze(false); setSnoozeInput('') }} style={{ flex:1, padding:'12px 0', borderRadius:8, border:'1px solid #555', background:'transparent', color:'#aaa', fontSize:13, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }}>BACK</button>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  function ThemeToggle() {
    return (
      <button onClick={() => setLightMode(m => !m)} title={lightMode ? 'Switch to Dark Mode' : 'Switch to Light Mode'}
        style={{ padding:'6px 10px', borderRadius:8, border:'1px solid var(--border)', background:'var(--navy3)', color:'var(--white)', fontSize:16, cursor:'pointer', lineHeight:1, flexShrink:0 }}>
        {lightMode ? '\uD83C\uDF19' : '\u2600\uFE0F'}
      </button>
    )
  }

  function AppLogo({ large }) {
    // Default product wordmark: lowercase "loadledgers" with a small "v5".
    // A real tenant shows THEIR name (uppercased as their brand), no version mark.
    const tenantName = tenantSettings && tenantSettings.display_name
    if (tenantName) {
      return (
        <div style={{ display:'flex', alignItems:'baseline', gap:6 }}>
          <div className="app-logo" style={ large ? { fontSize:32 } : {} }>{tenantName.toUpperCase()}</div>
        </div>
      )
    }
    return (
      <div style={{ display:'flex', alignItems:'baseline', gap:4 }}>
        <div className="app-logo" style={ large ? { fontSize:32, textTransform:'none' } : { textTransform:'none' } }>loadledgers</div>
        <div style={{ fontSize: large ? 13 : 10, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.04em', fontWeight:700, whiteSpace:'nowrap' }}>v5</div>
      </div>
    )
  }

  // CARRIER RATE TOGGLE (owner only) — sits just right of the company name in
  // the header. Three fixed rates (10 / 15 / 20). The active rate is the tenant's
  // live driver_split_pct; tapping another writes it. Not rendered for driver or
  // bookkeeper. Compact so it never crowds the wordmark on an iPhone header.
  function RateToggle() {
    if (!isOwner) return null
    const active = (tenantSettings && tenantSettings.driver_split_pct != null)
      ? Number(tenantSettings.driver_split_pct) : 10
    const rates = [10, 15, 20]
    return (
      <div title="Carrier rate charged to the driver" style={{ display:'flex', alignItems:'center', gap:3, marginLeft:8, flexShrink:0 }}>
        <span style={{ fontSize:9, color:'var(--grey)', fontFamily:'var(--font-head)', fontWeight:700, letterSpacing:'0.04em', marginRight:1 }}>RATE</span>
        {rates.map(r => {
          const on = active === r
          return (
            <button key={r} onClick={() => saveSplitPct(r)} disabled={savingSplit}
              style={{ padding:'4px 7px', borderRadius:6, border: on ? 'none' : '1px solid var(--border)',
                       background: on ? 'var(--amber)' : 'var(--navy3)', color: on ? '#0A1628' : 'var(--grey)',
                       fontSize:11, fontFamily:'var(--font-head)', fontWeight:900, lineHeight:1,
                       cursor: savingSplit ? 'default' : 'pointer', opacity: savingSplit && !on ? 0.5 : 1 }}>
              {r}%
            </button>
          )
        })}
      </div>
    )
  }

  // -- LOGIN SCREEN ------------------------------------------------------
  if (!driver) {
    return (
      <div style={{ display:'flex', flexDirection:'column', height:'100dvh', background:'var(--navy)', alignItems:'center', justifyContent:'center', padding:24 }}>
        <div style={{ width:'100%', maxWidth:360 }}>
          <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:16 }}><ThemeToggle /></div>
          <div style={{ textAlign:'center', marginBottom:32 }}>
            <div style={{ justifyContent:'center', display:'flex' }}><AppLogo large /></div>
          </div>
          <div style={{ background:'var(--navy2)', borderRadius:14, padding:24, border:'1px solid var(--border)' }}>
            <div style={{ fontSize:13, color:'var(--grey)', fontFamily:'var(--font-head)', fontWeight:700, letterSpacing:'0.1em', marginBottom:20, textAlign:'center' }}>SIGN IN</div>
            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.06em', marginBottom:6 }}>EMAIL</div>
              <input type="email" inputMode="email" autoCapitalize="none" autoCorrect="off" placeholder="your@email.com" value={email}
                onChange={e => { setEmail(e.target.value); setLoginError('') }}
                onKeyDown={e => e.key === 'Enter' && handleLogin()} />
            </div>
            <div style={{ marginBottom:20 }}>
              <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.06em', marginBottom:6 }}>PASSWORD</div>
              <div style={{ position:'relative' }}>
                <input type={showPassword ? 'text' : 'password'} placeholder="••••••••" value={password}
                  onChange={e => { setPassword(e.target.value); setLoginError('') }}
                  onKeyDown={e => e.key === 'Enter' && handleLogin()}
                  style={{ paddingRight:48 }} />
                <button onClick={() => setShowPassword(p => !p)} style={{ position:'absolute', right:12, top:'50%', transform:'translateY(-50%)', background:'transparent', border:'none', color:'var(--grey)', fontSize:14, cursor:'pointer', padding:'4px 8px' }}>
                  {showPassword ? '\uD83D\uDE48' : '\uD83D\uDC41'}
                </button>
              </div>
            </div>
            {loginError && (
              <div style={{ fontSize:13, color:'#e53935', fontFamily:'var(--font-head)', fontWeight:700, marginBottom:14, textAlign:'center' }}>{loginError}</div>
            )}
            <button onClick={handleLogin} disabled={loginLoading} style={{ width:'100%', padding:'16px 0', borderRadius:10, border:'none', background: loginLoading ? '#555' : 'var(--amber)', color: loginLoading ? '#aaa' : '#0A1628', fontSize:16, fontFamily:'var(--font-head)', fontWeight:900, cursor: loginLoading ? 'default' : 'pointer', letterSpacing:'0.05em' }}>
              {loginLoading ? 'SIGNING IN...' : 'SIGN IN'}
            </button>
          </div>
          <div style={{ textAlign:'center', fontSize:10, color:'var(--grey)', marginTop:20 }}>dbappsystems.com</div>
        </div>
        {toast && <div className="toast">{toast}</div>}
      </div>
    )
  }

  // -- MAIN APP ----------------------------------------------------------
  // LOADS breadcrumb shows only for drivers actively inside the new-load flow.
  const showLoadsCrumb = !isBookkeeper && tab === 'loads' && (loadsSubView === 'ratecon' || loadsSubView === 'invoice' || loadsSubView === 'ratecon-queue')

  // OWNER VISIBILITY: where the VIEWING driver selector renders. Bookkeeper
  // behavior is unchanged (Repairs + Assets). The owner additionally gets it
  // on Profile, so the driver-keyed desks there can be repointed.
  const showViewingBar =
    (isBookkeeper && (tab === 'maintenance' || tab === 'assets')) ||
    (isOwner && (tab === 'maintenance' || tab === 'assets' || tab === 'profile'))

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100dvh' }}>

      {renderCredAlert()}

      {/* HEADER */}
      <div className="app-header" style={{ position:'relative' }}>
        <div style={{ display:'flex', alignItems:'center', minWidth:0 }}>
          <AppLogo />
          <RateToggle />
        </div>
        {!isBookkeeper && tab === 'loads' && (loadsSubView === 'list' || loadsSubView === 'ratecon') && (
          <div style={{ position:'absolute', left:'50%', transform:'translateX(-50%)', display:'flex', alignItems:'center' }}>
            <IftaDailyLog driver={activeDriver} showToast={showToast} inline />
          </div>
        )}
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <ThemeToggle />
          <div style={{ fontSize:12, color:'var(--grey)', fontFamily:'var(--font-head)' }}>{driver}</div>
          <div className="badge">V5</div>
          <button onClick={logout} style={{ padding:'6px 12px', borderRadius:8, border:'1px solid var(--border)', background:'transparent', color:'var(--grey)', fontSize:11, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }}>LOGOUT</button>
        </div>
      </div>

      {/* DRIVER BAR */}
      <div className="driver-bar" style={{ justifyContent:'space-between', alignItems:'center', gap:8 }}>
        {showViewingBar ? (
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.06em' }}>VIEWING:</div>
            {/* WHITE-LABEL: tenant's own drivers via useDrivers() (was hardcoded BRUCE/TIM). */}
            {driverNames.map(d => (
              <button key={d} onClick={() => setViewDriver(d)} style={{ padding:'7px 16px', borderRadius:8, border:'none', background: activeDriver === d ? 'var(--amber)' : 'var(--navy3)', color: activeDriver === d ? '#0A1628' : 'var(--grey)', fontSize:12, fontFamily:'var(--font-head)', fontWeight:700, cursor:'pointer' }}>{d}</button>
            ))}
          </div>
        ) : (
          <div style={{ fontSize:11, color:'var(--grey)', fontFamily:'var(--font-head)', letterSpacing:'0.06em', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', flexShrink:1, minWidth:0 }}>LOGGED IN AS {driver}</div>
        )}

        {/* Centered LOADS breadcrumb — drivers only, inside new-load flow */}
        {showLoadsCrumb && (
          <button onClick={() => setLoadsSubView('list')} style={{ background:'transparent', border:'none', color:'var(--amber)', fontFamily:'var(--font-head)', fontWeight:900, fontSize:20, cursor:'pointer', letterSpacing:'0.06em', padding:0, flexShrink:0, lineHeight:1 }}>
            LOADS
          </button>
        )}

        {!isBookkeeper && (
          <button className="driver-btn active" style={{ flex:'0 0 auto', padding:'10px 20px' }} onClick={resetLoad}>+ NEW</button>
        )}
      </div>

      {/* MAIN CONTENT */}
      <div className="tab-content">

        {/* -- LOADS TAB ---------------------------------------- */}
        {tab === 'loads' && (
          <div style={{ display:'flex', flexDirection:'column', height:'100%' }}>

            {loadsSubView === 'ratecon' && !isBookkeeper && (
              <div style={{ flex:1, overflowY:'auto' }}>
                <RateCon load={load} setLoad={setLoad} driver={driver} showToast={showToast} onNext={() => setLoadsSubView('invoice')} onBooked={() => { fetchLoads(); afterInvoiceSave() }} onOpenQueue={() => setLoadsSubView('ratecon-queue')} pendingScanRc={pendingScanRc} onPendingScanDone={() => setPendingScanRc(null)} />
              </div>
            )}

            {loadsSubView === 'ratecon-queue' && !isBookkeeper && (
              <div style={{ flex:1, overflowY:'auto' }}>
                <RateConQueue driver={driver} showToast={showToast} onBack={() => setLoadsSubView('ratecon')} onScanRc={scanQueuedRc} />
              </div>
            )}

            {loadsSubView === 'invoice' && !isBookkeeper && (
              <div style={{ flex:1, overflowY:'auto' }}>
                <Invoice load={load} setLoad={setLoad} driver={driver} showToast={showToast} fetchLoads={fetchLoads} resetLoad={afterInvoiceSave} tenantSettings={tenantSettings} />
              </div>
            )}

            {(loadsSubView === 'list' || isBookkeeper) && (
              <div style={{ flex:1, overflowY:'auto' }}>
                <Loads loads={loads} setLoads={setLoads} driver={driver} showToast={showToast} fetchLoads={fetchLoads} tenantSettings={tenantSettings} />
              </div>
            )}

          </div>
        )}

        {/* -- PROFILE TAB - DRIVER / OWNER --------------- */}
        {tab === 'profile' && !isBookkeeper && (
          <div>
            <div className="section-title" style={{ paddingLeft:4 }}>SETTLEMENT REPORTS</div>
            <SettlementReport driverName={activeDriver} loads={billableLoads} showToast={showToast} ownerCutPct={ownerCutPct} />
            <div style={{ height:32 }} />
            <IftaEstimate driver={activeDriver} />
            <div style={{ height:12 }} />
            <IftaReport driver={activeDriver} />
            <div style={{ height:32 }} />
            <Tax loads={billableLoads} driver={activeDriver} />
            <div style={{ height:32 }} />
            <DriverProfile driver={activeDriver} showToast={showToast} />
            <div style={{ height:24 }} />
          </div>
        )}

        {/* -- PROFILE TAB - BOOKKEEPER ------------------ */}
        {tab === 'profile' && isBookkeeper && (
          <BookkeeperProfile loads={billableLoads} showToast={showToast} ownerCutPct={ownerCutPct} />
        )}

        {/* -- REPAIRS TAB -------------------------------- */}
        {tab === 'maintenance' && (
          <Maintenance driver={activeDriver} showToast={showToast} onEntriesChange={setMaintenanceEntries} role={role} ownerCutPct={ownerCutPct} tenantSettings={tenantSettings} />
        )}

        {/* -- ASSETS TAB --------------------------------- */}
        {tab === 'assets' && (
          <Assets driver={activeDriver} showToast={showToast} maintenanceEntries={maintenanceEntries} role={role} />
        )}

      </div>

      {/* -- TAB BAR ------------------------------------ */}
      <div className="tab-bar">

        <button className={`tab-item ${tab==='loads'?'active':''}`} onClick={() => setTab('loads')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
            <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
          </svg>
          Loads
        </button>

        <button className={`tab-item ${tab==='profile'?'active':''}`} onClick={() => setTab('profile')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
          </svg>
          Profile
        </button>

        <button className={`tab-item ${tab==='maintenance'?'active':''}`} onClick={() => setTab('maintenance')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>
          </svg>
          Repairs
        </button>

        <button className={`tab-item ${tab==='assets'?'active':''}`} onClick={() => setTab('assets')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 5v3h-7V8z"/>
            <circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>
          </svg>
          Assets
        </button>

      </div>

      {/* In-app feedback bubble — logged-in only, floats above the tab bar,
          posts to the DB (no email). */}
      <Feedback />

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
