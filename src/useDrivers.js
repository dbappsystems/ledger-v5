// src/useDrivers.js
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — shared tenant-driver source (white-label root fix).
//
// WHY THIS EXISTS
//   v4 hardcoded ['BRUCE','TIM'] and string-matched per-driver colors in App,
//   SettlementReport, BookkeeperProfile, Loads, etc. That is the white-label
//   blocker: a new tenant has different drivers. This hook is the ONE place the
//   app learns who a tenant's drivers are. Every component reads from here.
//
// SOURCE OF TRUTH
//   GET /api/drivers — tenant-scoped rows from the `drivers` table (migration
//   0003): { id, name (UPPERCASE key), display_name, is_owner_operator, color,
//   active }. We surface ACTIVE drivers only, in stable name order.
//
// SAFETY / NON-REGRESSION
//   If the call fails, returns empty, or the table isn't populated yet, we fall
//   back to the exact seeded identities for the existing tenant so the live
//   client (Edgerton: BRUCE blue/owner-op, TIM red/split) is unchanged. This
//   means shipping this hook can NEVER break the current app — worst case it
//   behaves exactly like the old hardcoded list.
//
// ACCOUNTING NOTE
//   This hook is identity/colors ONLY. It does NOT do settlement math. The
//   owner-operator 100%-keep path lives per-load in settlementMath.calcPay via
//   load.is_owner_operator — unchanged. is_owner_operator is exposed here only
//   for non-money UI (labels/badges) if a component wants it.

import { useState, useEffect } from 'react'
import { api as apiClient } from './api.js'

// The seeded identities for the original tenant. Used ONLY as a fallback so the
// app degrades to exactly the old behavior if /api/drivers is unavailable.
export const FALLBACK_DRIVERS = [
  { name: 'BRUCE', display_name: 'Bruce', color: '#1e88e5', is_owner_operator: 1, active: 1 },
  { name: 'TIM',   display_name: 'Tim',   color: '#e53935', is_owner_operator: 0, active: 1 },
]

// Normalize one API row into the shape the UI expects, filling sane defaults.
function normalizeDriver(d) {
  const name = String(d.name || '').toUpperCase()
  return {
    name,
    display_name: d.display_name || name,
    color: d.color || '#1e88e5',
    is_owner_operator: d.is_owner_operator ? 1 : 0,
    active: d.active === undefined ? 1 : (d.active ? 1 : 0),
  }
}

// Returns { drivers, names, colorFor, loading }.
//   drivers  : array of active driver objects (name/display_name/color/flag)
//   names    : array of UPPERCASE name keys — drop-in replacement for the old
//              hardcoded ['BRUCE','TIM']
//   colorFor : (name) => hex color, replacing the old `dn==='BRUCE'?...:...`
//   loading  : true until the first fetch resolves
export function useDrivers() {
  const [drivers, setDrivers] = useState(FALLBACK_DRIVERS)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const rows = await apiClient('/api/drivers')
        if (cancelled) return
        if (Array.isArray(rows) && rows.length > 0) {
          const active = rows.map(normalizeDriver).filter(d => d.active)
          // Stable, predictable order so the UI doesn't reshuffle between loads.
          active.sort((a, b) => a.name.localeCompare(b.name))
          setDrivers(active.length > 0 ? active : FALLBACK_DRIVERS)
        }
        // else: keep FALLBACK_DRIVERS (empty table -> old behavior)
      } catch {
        // network/auth error -> keep FALLBACK_DRIVERS (old behavior)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const names = drivers.map(d => d.name)
  const colorFor = (name) => {
    const hit = drivers.find(d => d.name === String(name || '').toUpperCase())
    return (hit && hit.color) || '#1e88e5'
  }

  return { drivers, names, colorFor, loading }
}
