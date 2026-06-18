// src/api.js
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — central API client.
//
// WHY THIS EXISTS
//   The V5 worker enforces the tenant wall: every data request must carry
//   "Authorization: Bearer <token>" or it gets 401. This module is the ONE
//   place that holds the token and attaches it to every call, so no component
//   ever talks to the API without it. Components call api(path, opts) instead
//   of fetch(API + path, ...).
//
// TOKEN LIFECYCLE
//   login()  -> stores token + tenant_id + driver + role in localStorage
//   api()    -> attaches the token; on 401 clears session and triggers re-login
//   logout() -> clears everything and tells the worker to drop the session

const API_BASE = import.meta.env.VITE_API_URL || 'https://ledger-v5.d49rwgmpj9.workers.dev';

const KEY = 'll_v5_session';

// ── session storage helpers ─────────────────────────────────────────────────
export function getSession() {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; }
  catch { return null; }
}
function setSession(s) { localStorage.setItem(KEY, JSON.stringify(s)); }
export function clearSession() { localStorage.removeItem(KEY); }
export function getToken() { return getSession()?.token || null; }

// Optional hook a component can register so a 401 bounces the user to login.
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

// ── LOGIN ───────────────────────────────────────────────────────────────────
// Returns { ok, driver_name, role, tenant_id } on success, or { ok:false, error }.
export async function login(email, password) {
  const res = await fetch(API_BASE + '/api/auth/login', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: String(email).trim().toLowerCase(), password }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.ok && data.token) {
    setSession({
      token:       data.token,
      tenant_id:   data.tenant_id,
      driver_name: data.driver_name,
      role:        data.role,
    });
    return { ok: true, driver_name: data.driver_name, role: data.role, tenant_id: data.tenant_id };
  }
  return { ok: false, error: data.error || 'Invalid email or password' };
}

// ── LOGOUT ──────────────────────────────────────────────────────────────────
export async function logout() {
  const token = getToken();
  if (token) {
    try {
      await fetch(API_BASE + '/api/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
      });
    } catch { /* ignore network error on logout */ }
  }
  clearSession();
}

// ── THE WRAPPER — use this for every API call ───────────────────────────────
// Usage:
//   const loads = await api('/api/loads');                  // GET, parsed JSON
//   await api('/api/loads', { method:'POST', json:{...} }); // POST with body
//   const res  = await api('/api/invoice/123', { raw:true });// raw Response (PDFs)
export async function api(path, opts = {}) {
  const token = getToken();
  const headers = { ...(opts.headers || {}) };
  if (token) headers['Authorization'] = 'Bearer ' + token;

  let body = opts.body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }

  const res = await fetch(API_BASE + path, { ...opts, headers, body });

  // The wall said no — session is dead or missing. Clear and bounce to login.
  if (res.status === 401) {
    clearSession();
    if (typeof onUnauthorized === 'function') onUnauthorized();
    throw new ApiError(401, 'Session expired — please log in again.');
  }

  if (opts.raw) return res; // caller wants the raw Response (e.g. PDF blob)

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && data.error) ? data.error : ('Request failed (' + res.status + ')');
    throw new ApiError(res.status, msg);
  }
  return data;
}

// Build an absolute URL for things that must be a real link (img src, iframe).
// These still need the token; for same-origin worker assets we append it as a
// query the worker can read if needed, but PREFER api(...,{raw:true}) + blob.
export function apiUrl(path) { return API_BASE + path; }

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export { API_BASE };
