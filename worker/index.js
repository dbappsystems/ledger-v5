// worker/index.js
// (c) dbappsystems.com 
// Load Ledger V5 — Cloudflare Worker — MULTI-TENANT
// OCR model: claude-sonnet-4-6 — matches the proven-working V4 worker. Do not
// change to a dated 4.5 snapshot; V4 confirms 4-6 is valid on this API key.

import { handleRouteIfta, handleIftaSummary } from './ifta.js';
import { handleIftaManual } from './ifta_manual.js';
import { handleRatecons } from './ratecons.js';
import { handleSettlementPayments } from './payments.js';
import { handleSignedMint, handleSignedServe } from './signed.js';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

const SESSION_TTL_HOURS = 12;

async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(salt + ':' + password);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(bytes) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function requireTenant(env, request) {
  const auth = request.headers.get('Authorization') || '';
  let token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token && request.method === 'GET') {
    token = (new URL(request.url).searchParams.get('t') || '').trim();
  }
  if (!token) throw new HttpError(401, 'Missing session token');

  const sess = await env.DB.prepare(
    'SELECT user_id, tenant_id, expires_at FROM sessions WHERE token = ?'
  ).bind(token).first();
  if (!sess) throw new HttpError(401, 'Invalid session');
  if (new Date(sess.expires_at) < new Date()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    throw new HttpError(401, 'Session expired');
  }
  const user = await env.DB.prepare(
    'SELECT driver_name, role FROM users WHERE id = ?'
  ).bind(sess.user_id).first();
  return {
    tenant_id:   sess.tenant_id,
    user_id:     sess.user_id,
    driver_name: user?.driver_name || '',
    role:        user?.role || 'driver',
  };
}

// Legacy V4 stored each invoice PDF (Edgerton top sheet + BOLs + receipts) in
// the V4 R2 bucket at key `invoices/{loadId}.pdf`. That bucket is bound here
// read-only as env.R2_V4 (load-ledger-files), and the V4 load id equals the V5
// load id, so V5 reads the object DIRECTLY in-process — no network hop, no
// dependency on the frozen V4 Worker staying alive. If the object is not in the
// bound bucket (e.g. binding unavailable), we fall back to the V4 Worker URL,
// preserving the exact behavior that already serves every migrated load.
const V4_BASE = 'https://load-ledger-v4.d49rwgmpj9.workers.dev';
async function getV4Invoice(env, loadId) {
  // 1) Direct read from the bound legacy bucket (fast path, self-contained).
  try {
    if (env.R2_V4) {
      const obj = await env.R2_V4.get('invoices/' + loadId + '.pdf');
      if (obj && obj.size > 1000) {
        const buf = await obj.arrayBuffer();
        return { arrayBuffer: async () => buf, body: buf };
      }
    }
  } catch (_) { /* fall through to URL fallback */ }
  // 2) Fallback: fetch the V4 Worker URL (legacy path, still works).
  try {
    const res = await fetch(V4_BASE + '/api/invoice/' + loadId);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct.indexOf('pdf') === -1) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 1000) return null;
    return { arrayBuffer: async () => buf, body: buf };
  } catch (_) {
    return null;
  }
}

// Legacy V4 also served maintenance and fuel receipt images/PDFs from its own
// public worker at /api/maintenance-receipt/{id} and /api/fuel-receipt/{id}.
// When a receipt has not yet been copied into the V5 bucket, fall back to the
// V4 worker URL so the receipt still displays. Same proven pattern as invoices.
// `kind` is 'maintenance-receipt' or 'fuel-receipt'.
async function getV4Receipt(env, kind, id) {
  // 1) Direct read from the bound legacy V4 bucket (self-contained, no auth).
  //    V4 stored maintenance receipts at maintenance/{id}.(pdf|jpg) and fuel
  //    receipts at fuel/{id}.(jpg|pdf). Read the same keys in-process.
  try {
    if (env && env.R2_V4) {
      const prefix = kind === 'fuel-receipt' ? 'fuel/' : 'maintenance/';
      // try both extensions; prefer jpg for fuel, pdf for maintenance, then swap
      const order = kind === 'fuel-receipt'
        ? [['jpg','image/jpeg'],['pdf','application/pdf']]
        : [['pdf','application/pdf'],['jpg','image/jpeg']];
      for (const [ext, ct] of order) {
        const obj = await env.R2_V4.get(prefix + id + '.' + ext);
        if (obj && obj.size > 500) {
          const buf = await obj.arrayBuffer();
          return { body: buf, contentType: ct };
        }
      }
    }
  } catch (_) { /* fall through to URL fallback */ }
  // 2) Fallback: fetch the V4 Worker URL. V4 auth-walls this route, so the
  //    unauthenticated fetch may 404; the direct bucket read above is primary.
  try {
    const res = await fetch(V4_BASE + '/api/' + kind + '/' + id);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct.indexOf('image') === -1 && ct.indexOf('pdf') === -1) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 500) return null;
    return { body: buf, contentType: ct };
  } catch (_) {
    return null;
  }
}

// DIAGNOSTIC (temporary): returns the raw outcome of the V4 fetch so we can see
// at runtime exactly why getV4Receipt yields null. Remove after diagnosis.
async function diagV4Receipt(kind, id) {
  try {
    const res = await fetch(V4_BASE + '/api/' + kind + '/' + id);
    const ct = res.headers.get('content-type') || '';
    let len = -1;
    try { const buf = await res.arrayBuffer(); len = buf.byteLength; } catch (e2) { len = 'arrayBuffer-threw:' + e2.message; }
    return { stage: 'fetched', status: res.status, ok: res.ok, contentType: ct, byteLength: len };
  } catch (e) {
    return { stage: 'fetch-threw', error: e.message };
  }
}

// ── GEOCODING (Nominatim) ────────────────────────────────────────────────
// Address -> {lat, lon} via OpenStreetMap Nominatim. Free, no key (Rule 14:
// never a secret in code). One stop at a time; caller sequences. Returns null
// on any miss so a stop can be saved un-geocoded and resolved later.
async function geocodeAddress({ address, city, state, zip }) {
  const q = [address, city, state, zip].filter(Boolean).join(', ').trim();
  if (!q) return null;
  try {
    const u = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q);
    const res = await fetch(u, { headers: { 'User-Agent': 'LoadLedgers/1.0 (dbappsystems.com)' } });
    if (!res.ok) return null;
    const arr = await res.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    const lat = parseFloat(arr[0].lat), lon = parseFloat(arr[0].lon);
    if (isNaN(lat) || isNaN(lon)) return null;
    return { lat, lon };
  } catch (_) {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }
    // Signed asset serve is public-by-token (no session): the short-lived,
    // non-guessable token IS the permission. Dispatched BEFORE requireTenant so
    // a plain <img>/<iframe>/new-tab link renders without a session in the URL.
    {
      const signedResp = await handleSignedServe(request, env, url);
      if (signedResp) return signedResp;
    }

    if (path === '/api/auth/login' && request.method === 'POST') {
      try {
        const { email, password } = await request.json();
        if (!email || !password) return json({ error: 'Missing email or password' }, 400);
        const user = await env.DB.prepare(
          'SELECT id, tenant_id, driver_name, role, password, salt FROM users WHERE LOWER(email) = LOWER(?)'
        ).bind(email.trim()).first();
        if (!user) return json({ error: 'Invalid email or password' }, 401);

        let ok = false;
        if (user.salt) {
          ok = (await hashPassword(password, user.salt)) === user.password;
        } else {
          ok = (user.password === password);
          if (ok) {
            const salt = randomHex(16);
            const hash = await hashPassword(password, salt);
            await env.DB.prepare('UPDATE users SET password=?, salt=? WHERE id=?')
              .bind(hash, salt, user.id).run();
          }
        }
        if (!ok) return json({ error: 'Invalid email or password' }, 401);
        if (!user.tenant_id) return json({ error: 'User has no tenant assigned' }, 403);

        const token = randomHex(32);
        const expires = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
        await env.DB.prepare(
          'INSERT INTO sessions (token, user_id, tenant_id, expires_at) VALUES (?,?,?,?)'
        ).bind(token, user.id, user.tenant_id, expires).run();

        return json({
          ok: true, token, tenant_id: user.tenant_id,
          driver_name: user.driver_name, role: user.role,
        });
      } catch(e) {
        return json({ error: e.message }, 500);
      }
    }

    if (path === '/api/auth/logout' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
      return json({ ok: true });
    }

    if (path === '/api/apply' && request.method === 'POST') {
      try {
        const b = await request.json();
        const company = (b.company_name || '').trim();
        const email   = (b.email || '').trim();
        if (!company) return json({ error: 'Company name is required' }, 400);
        if (!email)   return json({ error: 'Email is required' }, 400);
        const cap = (v, n) => (v == null ? '' : String(v).slice(0, n));
        const id = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO signup_requests
            (id, company_name, contact_name, email, phone, mc_number, dot_number, equipment, notes, status, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,'new',datetime('now'))
        `).bind(
          id, cap(company,200), cap(b.contact_name,120), cap(email,200),
          cap(b.phone,40), cap(b.mc_number,40), cap(b.dot_number,40),
          cap(b.equipment,500), cap(b.notes,2000),
        ).run();
        return json({ ok: true, id });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    let ctx;
    try {
      ctx = await requireTenant(env, request);
    } catch (e) {
      return json({ error: e.message }, e.status || 401);
    }
    const T = ctx.tenant_id;

    // Standalone rate confirmations (upload now, link at delivery). Handled
    // in its own module; returns a Response when it owns the path, else null.
    const rcResp = await handleRatecons(request, env, ctx, T, url);
    if (rcResp) return rcResp;
    // Driver payments (cash/check) + general-advance FIFO reconciliation.
    // Owns /api/settlement-payment(s); returns a Response when it does, else null.
    const payResp = await handleSettlementPayments(request, env, ctx, T, url);
    if (payResp) return payResp;
    // Mint a short-lived signed URL for an owned asset. Runs AFTER requireTenant
    // so ownership is re-verified against ctx before a token is issued.
    const signedMint = await handleSignedMint(request, env, ctx, T, url);
    if (signedMint) return signedMint;

    if (path === '/api/ocr' && request.method === 'POST') {
      try {
        const { base64, mediaType, mode } = await request.json();
        if (!base64 || !mediaType || !mode) return json({ error: 'Missing fields: base64, mediaType, mode' }, 400);
        if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not set in Worker secrets' }, 500);
        const prompt = getPrompt(mode);
        if (!prompt) return json({ error: 'Invalid mode: ' + mode }, 400);
        const isPdf = mediaType === 'application/pdf';
        const contentBlock = isPdf
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
          : { type: 'image',    source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 } };
        const headers = {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        };
        if (isPdf) headers['anthropic-beta'] = 'pdfs-2024-09-25';
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers,
          body: JSON.stringify({
            model: 'claude-sonnet-4-6', max_tokens: 2048, // raised from 1024: multi-stop rateconf stops[] needs headroom; a cap, not a cost
            messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }],
          }),
        });
        const raw = await res.text();
        if (!res.ok) {
          // Surface Anthropic's real error type + message so the failure names
          // itself on the phone, instead of a truncated raw blob.
          let etype = '', emsg = '';
          try {
            const ej = JSON.parse(raw);
            etype = ej?.error?.type    || '';
            emsg  = ej?.error?.message || '';
          } catch {}
          const detail = (etype || emsg)
            ? (etype + (emsg ? (': ' + emsg) : ''))
            : raw.slice(0, 300);
          return json({ error: 'Claude API error', status: res.status, type: etype, detail }, 502);
        }
        const data = JSON.parse(raw);
        return json({ result: data?.content?.[0]?.text ?? '' });
      } catch (e) {
        return json({ error: 'Worker exception', detail: e.message }, 500);
      }
    }

    if (path === '/api/loads' && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare(
          'SELECT * FROM loads WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100'
        ).bind(T).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path === '/api/loads' && request.method === 'POST') {
      try {
        const b = await request.json();
        const id = crypto.randomUUID();
        const driverVal = b.driver || '';

        let brokerId = '';
        if (b.broker_name && b.broker_name.trim()) {
          const existingBroker = await env.DB.prepare(
            'SELECT id FROM brokers WHERE tenant_id = ? AND UPPER(broker_name) = UPPER(?)'
          ).bind(T, b.broker_name.trim()).first();
          if (existingBroker) {
            brokerId = existingBroker.id;
            const uFields = []; const uVals = [];
            if (b.broker_mc      && b.broker_mc.trim())      { uFields.push('broker_mc=?');      uVals.push(b.broker_mc.trim()); }
            if (b.broker_phone   && b.broker_phone.trim())   { uFields.push('broker_phone=?');   uVals.push(b.broker_phone.trim()); }
            if (b.broker_email   && b.broker_email.trim())   { uFields.push('broker_email=?');   uVals.push(b.broker_email.trim()); }
            if (b.broker_contact && b.broker_contact.trim()) { uFields.push('broker_contact=?'); uVals.push(b.broker_contact.trim()); }
            if (b.broker_address && b.broker_address.trim()) { uFields.push('broker_address=?'); uVals.push(b.broker_address.trim()); }
            if (uFields.length > 0) {
              uFields.push("updated_at=datetime('now')");
              uVals.push(brokerId, T);
              await env.DB.prepare(
                'UPDATE brokers SET ' + uFields.join(', ') + ' WHERE id=? AND tenant_id=?'
              ).bind(...uVals).run();
            }
          } else {
            brokerId = crypto.randomUUID();
            await env.DB.prepare(`
              INSERT INTO brokers
                (id, tenant_id, broker_name, broker_mc, broker_phone, broker_email,
                 broker_contact, broker_address, notes, total_loads, total_gross,
                 created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,'',0,0,datetime('now'),datetime('now'))
            `).bind(
              brokerId, T, b.broker_name.trim(),
              b.broker_mc||'', b.broker_phone||'', b.broker_email||'',
              b.broker_contact||'', b.broker_address||'',
            ).run();
          }
        }

        // Persist the full line-item arrays (lumpers/incidentals/comdatas) on the
        // initial save — not just the totals. Without these, a reloaded load card
        // cannot render the Lumper/Comdata lines and only shows base pay + totals.
        // Accepts either a JSON string or an array from the client.
        const asJson = (v) => {
          if (v == null) return '[]';
          if (typeof v === 'string') { const s = v.trim(); return s ? s : '[]'; }
          try { return JSON.stringify(v); } catch { return '[]'; }
        };
        const lumpersJson     = asJson(b.lumpers);
        const incidentalsJson = asJson(b.incidentals);
        const comdatasJson    = asJson(b.comdatas);

        await env.DB.prepare(`
          INSERT INTO loads
            (id, tenant_id, driver_id, driver, broker_id, broker_name, broker_email, load_number,
             origin, destination, pickup_date, delivery_date,
             base_pay, lumper_total, incidental_total, comdata_total,
             lumpers, incidentals, comdatas,
             detention, pallets, net_pay, notes, bol_count, fuel, status, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
        `).bind(
          id, T, driverVal, driverVal, brokerId,
          b.broker_name||'', b.broker_email||'', b.load_number||'',
          b.origin||'', b.destination||'', b.pickup_date||'', b.delivery_date||'',
          b.base_pay||0, b.lumper_total||0, b.incidental_total||0,
          b.comdata_total||0,
          lumpersJson, incidentalsJson, comdatasJson,
          b.detention||0, b.pallets||0,
          b.net_pay||0, b.notes||'', b.bol_count||0, b.fuel||0,
          b.status||'invoiced',
        ).run();
        return json({ id });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path === '/api/upload-pdf' && request.method === 'POST') {
      try {
        const { base64, loadId } = await request.json();
        if (!base64 || !loadId) return json({ error: 'Missing base64 or loadId' }, 400);
        if (!env.R2) return json({ error: 'R2 not configured' }, 500);
        const owns = await env.DB.prepare('SELECT id FROM loads WHERE id=? AND tenant_id=?').bind(loadId, T).first();
        if (!owns) return json({ error: 'Load not found' }, 404);
        const binary = atob(base64); const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        await env.R2.put(T + '/invoices/' + loadId + '.pdf', bytes, { httpMetadata: { contentType: 'application/pdf' } });
        const invoiceUrl = '/api/invoice/' + loadId;
        await env.DB.prepare('UPDATE loads SET invoice_url=? WHERE id=? AND tenant_id=?').bind(invoiceUrl, loadId, T).run();
        return json({ ok: true, url: invoiceUrl });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── RATE CON STORAGE (R2) ────────────────────────────────────────────
    // The rate confirmation is the load's CONTRACT. The client assembles the
    // scanned RC into one PDF and stores it here at booking (status='booked')
    // or at billing time. Same tenant-walled R2 pattern as /api/upload-pdf.
    if (path === '/api/ratecon-pdf' && request.method === 'POST') {
      try {
        const { base64, loadId } = await request.json();
        if (!base64 || !loadId) return json({ error: 'Missing base64 or loadId' }, 400);
        if (!env.R2) return json({ error: 'R2 not configured' }, 500);
        const owns = await env.DB.prepare('SELECT id FROM loads WHERE id=? AND tenant_id=?').bind(loadId, T).first();
        if (!owns) return json({ error: 'Load not found' }, 404);
        const binary = atob(base64); const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        await env.R2.put(T + '/ratecons/' + loadId + '.pdf', bytes, { httpMetadata: { contentType: 'application/pdf' } });
        const rateConUrl = '/api/ratecon/' + loadId;
        await env.DB.prepare('UPDATE loads SET rate_conf_url=? WHERE id=? AND tenant_id=?').bind(rateConUrl, loadId, T).run();
        return json({ ok: true, url: rateConUrl });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/ratecon/') && request.method === 'GET') {
      try {
        const loadId = path.replace('/api/ratecon/', '');
        if (!env.R2) return json({ error: 'R2 not configured' }, 500);
        const owns = await env.DB.prepare('SELECT id FROM loads WHERE id=? AND tenant_id=?').bind(loadId, T).first();
        if (!owns) return new Response('Rate con not found', { status: 404, headers: CORS });
        const object = await env.R2.get(T + '/ratecons/' + loadId + '.pdf');
        if (!object) return new Response('Rate con not found', { status: 404, headers: CORS });
        return new Response(object.body, {
          headers: { ...CORS, 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=3600' },
        });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── SAVE LEGACY V4 INVOICE INTO V5 (fetch V4 URL -> R2) ──────────────
    if (path.startsWith('/api/invoice/') && path.endsWith('/save') && request.method === 'POST') {
      try {
        const loadId = path.slice('/api/invoice/'.length, -('/save'.length));
        if (!env.R2) return json({ error: 'R2 not configured' }, 500);
        const owns = await env.DB.prepare(
          'SELECT id, driver FROM loads WHERE id=? AND tenant_id=?'
        ).bind(loadId, T).first();
        if (!owns) return json({ error: 'Load not found' }, 404);
        if (ctx.role !== 'owner' && ctx.role !== 'bookkeeper' &&
            (owns.driver || '').toUpperCase() !== (ctx.driver_name || '').toUpperCase()) {
          return json({ error: 'Not authorized' }, 403);
        }
        const existing = await env.R2.get(T + '/invoices/' + loadId + '.pdf');
        if (existing && existing.size > 5000) {
          await env.DB.prepare('UPDATE loads SET invoice_url=? WHERE id=? AND tenant_id=?')
            .bind('/api/invoice/' + loadId, loadId, T).run();
          return json({ ok: true, alreadyInV5: true });
        }
        const v4 = await getV4Invoice(env, loadId);
        if (!v4) return json({ error: 'No stored V4 invoice for this load' }, 404);
        const buf = await v4.arrayBuffer();
        if (buf.byteLength < 1000) return json({ error: 'V4 object too small to be a PDF' }, 422);
        await env.R2.put(T + '/invoices/' + loadId + '.pdf', buf, {
          httpMetadata: { contentType: 'application/pdf' },
        });
        await env.DB.prepare('UPDATE loads SET invoice_url=? WHERE id=? AND tenant_id=?')
          .bind('/api/invoice/' + loadId, loadId, T).run();
        return json({ ok: true, savedBytes: buf.byteLength });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── SERVE INVOICE PDF (V5 bucket, with V4 fallback) ──────────────────
    if (path.startsWith('/api/invoice/') && request.method === 'GET') {
      try {
        const loadId = path.replace('/api/invoice/', '');
        if (!env.R2) return json({ error: 'R2 not configured' }, 500);
        const owns = await env.DB.prepare('SELECT id FROM loads WHERE id=? AND tenant_id=?').bind(loadId, T).first();
        if (!owns) return new Response('Invoice not found', { status: 404, headers: CORS });
        let object = await env.R2.get(T + '/invoices/' + loadId + '.pdf');
        if (object) {
          return new Response(object.body, {
            headers: { ...CORS, 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=3600' },
          });
        }
        const v4 = await getV4Invoice(env, loadId);
        if (!v4) return new Response('Invoice not found', { status: 404, headers: CORS });
        return new Response(v4.body, {
          headers: { ...CORS, 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=3600' },
        });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/credentials/') && !path.includes('/file/') && request.method === 'GET') {
      try {
        const driver = path.split('/')[3].toUpperCase();
        let row = await env.DB.prepare(
          'SELECT * FROM driver_credentials WHERE tenant_id=? AND driver=?'
        ).bind(T, driver).first();
        if (!row) {
          row = {
            driver,
            dot_physical: '', drivers_license: '', cab_card: '', plates: '',
            authority: '', insurance: '', heavy_use_tax: '',
            dot_physical_snooze: '', drivers_license_snooze: '', cab_card_snooze: '',
            plates_snooze: '', authority_snooze: '',
            insurance_snooze: '', heavy_use_tax_snooze: '',
          };
        }
        return json(row);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/credentials/') && !path.includes('/file/') && request.method === 'PATCH') {
      try {
        const driver = path.split('/')[3].toUpperCase();
        const b = await request.json();
        await env.DB.prepare(`
          INSERT INTO driver_credentials
            (tenant_id, driver, dot_physical, drivers_license, cab_card, plates, authority, insurance, heavy_use_tax,
             dot_physical_snooze, drivers_license_snooze, cab_card_snooze, plates_snooze,
             authority_snooze, insurance_snooze, heavy_use_tax_snooze, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
          ON CONFLICT(tenant_id, driver) DO UPDATE SET
            dot_physical=excluded.dot_physical,
            drivers_license=excluded.drivers_license,
            cab_card=excluded.cab_card,
            plates=excluded.plates,
            authority=excluded.authority,
            insurance=excluded.insurance,
            heavy_use_tax=excluded.heavy_use_tax,
            dot_physical_snooze=excluded.dot_physical_snooze,
            drivers_license_snooze=excluded.drivers_license_snooze,
            cab_card_snooze=excluded.cab_card_snooze,
            plates_snooze=excluded.plates_snooze,
            authority_snooze=excluded.authority_snooze,
            insurance_snooze=excluded.insurance_snooze,
            heavy_use_tax_snooze=excluded.heavy_use_tax_snooze,
            updated_at=excluded.updated_at
        `).bind(
          T, driver,
          b.dot_physical||'', b.drivers_license||'', b.cab_card||'', b.plates||'',
          b.authority||'', b.insurance||'', b.heavy_use_tax||'',
          b.dot_physical_snooze||'', b.drivers_license_snooze||'', b.cab_card_snooze||'',
          b.plates_snooze||'', b.authority_snooze||'',
          b.insurance_snooze||'', b.heavy_use_tax_snooze||'',
        ).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.includes('/api/credentials/') && path.includes('/file/') && request.method === 'POST') {
      try {
        const parts = path.split('/');
        const driver = parts[3].toUpperCase();
        const credKey = parts[5];
        if (!env.R2) return json({ error: 'R2 not configured' }, 500);
        const { base64, mediaType } = await request.json();
        const binary = atob(base64); const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const ext = mediaType === 'application/pdf' ? 'pdf' : 'jpg';
        await env.R2.put(T + '/credentials/' + driver + '/' + credKey + '.' + ext, bytes, { httpMetadata: { contentType: mediaType } });
        return json({ ok: true, url: '/api/credentials/' + driver + '/file/' + credKey });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.includes('/api/credentials/') && path.includes('/file/') && request.method === 'GET') {
      try {
        const parts = path.split('/');
        const driver = parts[3].toUpperCase();
        const credKey = parts[5];
        if (!env.R2) return json({ error: 'R2 not configured' }, 500);
        let object = await env.R2.get(T + '/credentials/' + driver + '/' + credKey + '.pdf');
        let contentType = 'application/pdf';
        if (!object) {
          object = await env.R2.get(T + '/credentials/' + driver + '/' + credKey + '.jpg');
          contentType = 'image/jpeg';
        }
        if (!object) return new Response('File not found', { status: 404, headers: CORS });
        return new Response(object.body, {
          headers: { ...CORS, 'Content-Type': contentType, 'Content-Disposition': 'inline', 'Cache-Control': 'no-store, no-cache, must-revalidate' },
        });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/maintenance/') && request.method === 'GET') {
      try {
        const driver = path.split('/')[3].toUpperCase();
        const { results } = await env.DB.prepare(
          'SELECT * FROM maintenance_ledger WHERE tenant_id=? AND driver=? ORDER BY entry_date DESC, created_at DESC LIMIT 200'
        ).bind(T, driver).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path === '/api/maintenance' && request.method === 'POST') {
      try {
        const b = await request.json();
        const id = crypto.randomUUID();
        if (!b.driver) return json({ error: 'Missing driver' }, 400);
        await env.DB.prepare(`
          INSERT INTO maintenance_ledger
            (id, tenant_id, driver, entry_date, category, description, amount, paid_by, asset_id, receipt_url, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))
        `).bind(
          id, T, b.driver.toUpperCase(), b.entry_date||'',
          b.category||'Other', b.description||'',
          parseFloat(b.amount)||0, b.paid_by||'TIM', b.asset_id||'', b.receipt_url||'',
        ).run();
        return json({ id });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/maintenance/') && path.split('/').length === 4 && request.method === 'PATCH') {
      try {
        const id = path.split('/')[3];
        const b = await request.json();
        const fields = []; const values = [];
        if (b.paid_by              !== undefined) { fields.push('paid_by=?');             values.push(b.paid_by); }
        if (b.asset_id             !== undefined) { fields.push('asset_id=?');            values.push(b.asset_id); }
        if (b.paid_by_changed_at   !== undefined) { fields.push('paid_by_changed_at=?');  values.push(b.paid_by_changed_at); }
        if (b.paid_by_changed_from !== undefined) { fields.push('paid_by_changed_from=?'); values.push(b.paid_by_changed_from); }
        if (fields.length === 0) return json({ error: 'Nothing to update' }, 400);
        values.push(id, T);
        await env.DB.prepare('UPDATE maintenance_ledger SET ' + fields.join(', ') + ' WHERE id=? AND tenant_id=?').bind(...values).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/maintenance/') && path.split('/').length === 4 && request.method === 'DELETE') {
      try {
        const id = path.split('/')[3];
        const { driver } = await request.json();
        const row = await env.DB.prepare('SELECT driver FROM maintenance_ledger WHERE id=? AND tenant_id=?').bind(id, T).first();
        if (!row) return json({ error: 'Entry not found' }, 404);
        if (row.driver !== driver.toUpperCase() && ctx.role !== 'bookkeeper' && ctx.role !== 'owner') {
          return json({ error: 'Not authorized' }, 403);
        }
        if (env.R2) {
          await env.R2.delete(T + '/maintenance/' + id + '.pdf').catch(() => {});
          await env.R2.delete(T + '/maintenance/' + id + '.jpg').catch(() => {});
        }
        await env.DB.prepare('DELETE FROM maintenance_ledger WHERE id=? AND tenant_id=?').bind(id, T).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/maintenance-receipt/') && request.method === 'POST') {
      try {
        const entryId = path.split('/')[3];
        if (!env.R2) return json({ error: 'R2 not configured' }, 500);
        const owns = await env.DB.prepare('SELECT id FROM maintenance_ledger WHERE id=? AND tenant_id=?').bind(entryId, T).first();
        if (!owns) return json({ error: 'Entry not found' }, 404);
        const { base64, mediaType } = await request.json();
        const binary = atob(base64); const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const ext = mediaType === 'application/pdf' ? 'pdf' : 'jpg';
        await env.R2.put(T + '/maintenance/' + entryId + '.' + ext, bytes, { httpMetadata: { contentType: mediaType } });
        const receiptUrl = '/api/maintenance-receipt/' + entryId;
        await env.DB.prepare('UPDATE maintenance_ledger SET receipt_url=? WHERE id=? AND tenant_id=?').bind(receiptUrl, entryId, T).run();
        return json({ ok: true, url: receiptUrl });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/maintenance-receipt/') && request.method === 'GET') {
      try {
        const entryId = path.split('/')[3];
        if (!env.R2) return json({ error: 'R2 not configured' }, 500);
        const owns = await env.DB.prepare('SELECT id FROM maintenance_ledger WHERE id=? AND tenant_id=?').bind(entryId, T).first();
        if (!owns) return new Response('Receipt not found', { status: 404, headers: CORS });
        let object = await env.R2.get(T + '/maintenance/' + entryId + '.pdf');
        let contentType = 'application/pdf';
        if (!object) { object = await env.R2.get(T + '/maintenance/' + entryId + '.jpg'); contentType = 'image/jpeg'; }
        if (object) {
          return new Response(object.body, {
            headers: { ...CORS, 'Content-Type': contentType, 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=3600' },
          });
        }
        if (url.searchParams.get('diag') === '1') {
          const d = await diagV4Receipt('maintenance-receipt', entryId);
          return json({ diag: true, entryId, v4base: V4_BASE, result: d });
        }
        const v4 = await getV4Receipt(env, 'maintenance-receipt', entryId);
        if (!v4) return new Response('Receipt not found', { status: 404, headers: CORS });
        return new Response(v4.body, {
          headers: { ...CORS, 'Content-Type': v4.contentType || 'image/jpeg', 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=3600' },
        });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/escrow-payments/') && request.method === 'GET') {
      try {
        const driver = path.split('/')[3].toUpperCase();
        const { results } = await env.DB.prepare(
          'SELECT * FROM escrow_payments WHERE tenant_id=? AND driver=? ORDER BY funded_at DESC LIMIT 200'
        ).bind(T, driver).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path === '/api/escrow-payment' && request.method === 'POST') {
      try {
        const b = await request.json();
        const id = crypto.randomUUID();
        if (!b.driver) return json({ error: 'Missing driver' }, 400);
        const amount = parseFloat(b.amount);
        if (!amount || amount <= 0) return json({ error: 'Invalid amount' }, 400);
        await env.DB.prepare(`
          INSERT INTO escrow_payments (id, tenant_id, driver, amount, funded_at, created_at)
          VALUES (?,?,?,?,?,datetime('now'))
        `).bind(id, T, b.driver.toUpperCase(), amount, b.funded_at || new Date().toISOString()).run();
        return json({ id });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/assets/') && !path.includes('/payments') && request.method === 'GET') {
      try {
        const driver = path.split('/')[3].toUpperCase();
        const { results } = await env.DB.prepare(
          'SELECT * FROM assets WHERE tenant_id=? AND driver=? ORDER BY created_at ASC'
        ).bind(T, driver).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path === '/api/assets' && request.method === 'POST') {
      try {
        const b = await request.json();
        const id = crypto.randomUUID();
        if (!b.driver) return json({ error: 'Missing driver' }, 400);
        await env.DB.prepare(`
          INSERT INTO assets
            (id, tenant_id, driver, asset_name, asset_type, year, make, model, vin_last6,
             notes, purchase_price, balance_owed, owed_to, purchase_date,
             estimated_value, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
        `).bind(
          id, T, b.driver.toUpperCase(),
          b.asset_name||'', b.asset_type||'',
          b.year||'', b.make||'', b.model||'', b.vin_last6||'',
          b.notes||'',
          parseFloat(b.purchase_price)||0, parseFloat(b.balance_owed)||0,
          b.owed_to||'', b.purchase_date||'', parseFloat(b.estimated_value)||0,
        ).run();
        return json({ id });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/assets/') && !path.includes('/payments') && request.method === 'PATCH') {
      try {
        const id = path.split('/')[3];
        const b = await request.json();
        const fields = []; const values = [];
        const allowed = ['asset_name','asset_type','year','make','model','vin_last6','notes',
                         'purchase_price','balance_owed','owed_to','purchase_date','estimated_value'];
        allowed.forEach(key => {
          if (b[key] !== undefined) {
            fields.push(key + '=?');
            values.push(['purchase_price','balance_owed','estimated_value'].includes(key) ? parseFloat(b[key])||0 : b[key]);
          }
        });
        if (fields.length === 0) return json({ error: 'Nothing to update' }, 400);
        values.push(id, T);
        await env.DB.prepare('UPDATE assets SET ' + fields.join(', ') + ' WHERE id=? AND tenant_id=?').bind(...values).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/assets/') && !path.includes('/payments') && request.method === 'DELETE') {
      try {
        const id = path.split('/')[3];
        const { driver } = await request.json();
        const row = await env.DB.prepare('SELECT driver FROM assets WHERE id=? AND tenant_id=?').bind(id, T).first();
        if (!row) return json({ error: 'Asset not found' }, 404);
        if (row.driver !== driver.toUpperCase() && ctx.role !== 'bookkeeper' && ctx.role !== 'owner') {
          return json({ error: 'Not authorized' }, 403);
        }
        await env.DB.prepare('DELETE FROM assets WHERE id=? AND tenant_id=?').bind(id, T).run();
        await env.DB.prepare('DELETE FROM asset_payments WHERE asset_id=? AND tenant_id=?').bind(id, T).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.includes('/api/assets/') && path.includes('/payments') && request.method === 'GET') {
      try {
        const assetId = path.split('/')[3];
        const { results } = await env.DB.prepare(
          'SELECT * FROM asset_payments WHERE asset_id=? AND tenant_id=? ORDER BY payment_date DESC, created_at DESC'
        ).bind(assetId, T).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.includes('/api/assets/') && path.includes('/payments') && !path.includes('/payments/') && request.method === 'POST') {
      try {
        const assetId = path.split('/')[3];
        const b = await request.json();
        const id = crypto.randomUUID();
        if (!b.driver) return json({ error: 'Missing driver' }, 400);
        const owns = await env.DB.prepare('SELECT id FROM assets WHERE id=? AND tenant_id=?').bind(assetId, T).first();
        if (!owns) return json({ error: 'Asset not found' }, 404);
        const amount = parseFloat(b.amount) || 0;
        await env.DB.prepare(`
          INSERT INTO asset_payments (id, tenant_id, asset_id, driver, payment_date, amount, notes, created_at)
          VALUES (?,?,?,?,?,?,?,datetime('now'))
        `).bind(id, T, assetId, b.driver.toUpperCase(), b.payment_date||'', amount, b.notes||'').run();
        await env.DB.prepare('UPDATE assets SET balance_owed = MAX(0, balance_owed - ?) WHERE id=? AND tenant_id=?').bind(amount, assetId, T).run();
        return json({ id });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.includes('/api/assets/') && path.includes('/payments/') && request.method === 'DELETE') {
      try {
        const parts = path.split('/');
        const assetId = parts[3];
        const paymentId = parts[5];
        const { driver } = await request.json();
        const row = await env.DB.prepare('SELECT driver, amount FROM asset_payments WHERE id=? AND tenant_id=?').bind(paymentId, T).first();
        if (!row) return json({ error: 'Payment not found' }, 404);
        if (row.driver !== driver.toUpperCase() && ctx.role !== 'bookkeeper' && ctx.role !== 'owner') {
          return json({ error: 'Not authorized' }, 403);
        }
        await env.DB.prepare('DELETE FROM asset_payments WHERE id=? AND tenant_id=?').bind(paymentId, T).run();
        await env.DB.prepare('UPDATE assets SET balance_owed = balance_owed + ? WHERE id=? AND tenant_id=?').bind(row.amount, assetId, T).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/loads/') && request.method === 'PATCH') {
      try {
        const id = path.split('/')[3];
        const b = await request.json();
        const fields = []; const values = [];
        if (b.status       !== undefined) { fields.push('status=?');       values.push(b.status); }
        // BOOKED→INVOICED billing path: the invoice form may correct any of the
        // fields captured at booking, plus the line-item totals.
        if (b.broker_name      !== undefined) { fields.push('broker_name=?');      values.push(b.broker_name); }
        if (b.broker_email     !== undefined) { fields.push('broker_email=?');     values.push(b.broker_email); }
        if (b.load_number      !== undefined) { fields.push('load_number=?');      values.push(b.load_number); }
        if (b.origin           !== undefined) { fields.push('origin=?');           values.push(b.origin); }
        if (b.destination      !== undefined) { fields.push('destination=?');      values.push(b.destination); }
        if (b.pickup_date      !== undefined) { fields.push('pickup_date=?');      values.push(b.pickup_date); }
        if (b.delivery_date    !== undefined) { fields.push('delivery_date=?');    values.push(b.delivery_date); }
        if (b.bol_count        !== undefined) { fields.push('bol_count=?');        values.push(parseInt(b.bol_count) || 0); }
        if (b.lumper_total     !== undefined) { fields.push('lumper_total=?');     values.push(parseFloat(b.lumper_total)     || 0); }
        if (b.incidental_total !== undefined) { fields.push('incidental_total=?'); values.push(parseFloat(b.incidental_total) || 0); }
        if (b.comdata_total    !== undefined) { fields.push('comdata_total=?');    values.push(parseFloat(b.comdata_total)    || 0); }
        if (b.fuel         !== undefined) { fields.push('fuel=?');         values.push(parseFloat(b.fuel) || 0); }
        if (b.base_pay     !== undefined) { fields.push('base_pay=?');     values.push(parseFloat(b.base_pay)  || 0); }
        if (b.detention    !== undefined) { fields.push('detention=?');    values.push(parseFloat(b.detention) || 0); }
        if (b.pallets      !== undefined) { fields.push('pallets=?');      values.push(parseFloat(b.pallets)   || 0); }
        if (b.net_pay      !== undefined) { fields.push('net_pay=?');      values.push(parseFloat(b.net_pay)   || 0); }
        if (b.notes        !== undefined) { fields.push('notes=?');        values.push(b.notes); }
        if (b.lumpers      !== undefined) { fields.push('lumpers=?');      values.push(typeof b.lumpers      === 'string' ? b.lumpers      : JSON.stringify(b.lumpers)); }
        if (b.incidentals  !== undefined) { fields.push('incidentals=?');  values.push(typeof b.incidentals  === 'string' ? b.incidentals  : JSON.stringify(b.incidentals)); }
        if (b.comdatas     !== undefined) { fields.push('comdatas=?');     values.push(typeof b.comdatas     === 'string' ? b.comdatas     : JSON.stringify(b.comdatas)); }
        if (b.edited       !== undefined) { fields.push('edited=?');       values.push(b.edited); }
        if (b.edited_date  !== undefined) { fields.push('edited_date=?');  values.push(b.edited_date); }
        if (b.ach_payment  !== undefined) { fields.push('ach_payment=?');  values.push(b.ach_payment ? 1 : 0); }
        if (b.ach_received !== undefined) { fields.push('ach_received=?'); values.push(parseFloat(b.ach_received) || 0); }
        if (fields.length === 0) return json({ error: 'Nothing to update' }, 400);
        values.push(id, T);
        await env.DB.prepare('UPDATE loads SET ' + fields.join(', ') + ' WHERE id=? AND tenant_id=?').bind(...values).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/loads/') && request.method === 'DELETE') {
      try {
        const id = path.split('/')[3];
        let driver = '';
        try { ({ driver } = await request.json()); } catch {}
        if (!driver) return json({ error: 'Missing driver' }, 400);
        const who = driver.toUpperCase();
        const row = await env.DB.prepare('SELECT driver FROM loads WHERE id=? AND tenant_id=?').bind(id, T).first();
        if (!row) return json({ error: 'Load not found' }, 404);
        if (ctx.role !== 'owner' && row.driver !== who) {
          return json({ error: 'Not authorized' }, 403);
        }
        if (env.R2) await env.R2.delete(T + '/invoices/' + id + '.pdf').catch(() => {});
        if (env.R2) await env.R2.delete(T + '/ratecons/' + id + '.pdf').catch(() => {});
        await env.DB.prepare('DELETE FROM ifta_miles WHERE tenant_id=? AND load_id=?').bind(T, id).run();
        await env.DB.prepare('DELETE FROM load_stops WHERE tenant_id=? AND load_id=?').bind(T, id).run();
        await env.DB.prepare('DELETE FROM loads WHERE id=? AND tenant_id=?').bind(id, T).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/fuel/') && request.method === 'GET') {
      try {
        const driver = path.split('/')[3].toUpperCase();
        const { results } = await env.DB.prepare(
          'SELECT * FROM fuel_entries WHERE tenant_id=? AND driver=? ORDER BY entry_date DESC, created_at DESC LIMIT 500'
        ).bind(T, driver).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path === '/api/fuel' && request.method === 'POST') {
      try {
        const b = await request.json();
        const id = crypto.randomUUID();
        if (!b.driver) return json({ error: 'Missing driver' }, 400);
        await env.DB.prepare(`
          INSERT INTO fuel_entries
            (id, tenant_id, driver, entry_date, amount, fuel_type, notes, receipt_url, odometer, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
        `).bind(
          id, T, b.driver.toUpperCase(),
          b.entry_date || new Date().toISOString().split('T')[0],
          parseFloat(b.amount)||0, b.fuel_type||'fleet', b.notes||'', b.receipt_url||'',
          (b.odometer === undefined || b.odometer === null || b.odometer === '') ? null : (parseFloat(b.odometer) || 0),
        ).run();
        return json({ id });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/fuel/') && path.split('/').length === 4 && request.method === 'PATCH') {
      try {
        const id = path.split('/')[3];
        const b = await request.json();
        const fields = []; const values = [];
        if (b.entry_date !== undefined) { fields.push('entry_date=?'); values.push(b.entry_date); }
        if (b.amount     !== undefined) { fields.push('amount=?');     values.push(parseFloat(b.amount) || 0); }
        if (b.fuel_type  !== undefined) { fields.push('fuel_type=?');  values.push(b.fuel_type === 'pocket' ? 'pocket' : 'fleet'); }
        if (b.notes      !== undefined) { fields.push('notes=?');      values.push(b.notes); }
        if (b.odometer   !== undefined) { fields.push('odometer=?');   values.push((b.odometer === null || b.odometer === '') ? null : (parseFloat(b.odometer) || 0)); }
        if (fields.length === 0) return json({ error: 'Nothing to update' }, 400);
        values.push(id, T);
        await env.DB.prepare('UPDATE fuel_entries SET ' + fields.join(', ') + ' WHERE id=? AND tenant_id=?').bind(...values).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/fuel/') && path.split('/').length === 4 && request.method === 'DELETE') {
      try {
        const id = path.split('/')[3];
        const row = await env.DB.prepare('SELECT id FROM fuel_entries WHERE id=? AND tenant_id=?').bind(id, T).first();
        if (!row) return json({ error: 'Entry not found' }, 404);
        if (env.R2) {
          await env.R2.delete(T + '/fuel/' + id + '.jpg').catch(() => {});
          await env.R2.delete(T + '/fuel/' + id + '.pdf').catch(() => {});
        }
        await env.DB.prepare('DELETE FROM fuel_entries WHERE id=? AND tenant_id=?').bind(id, T).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ─── FUEL REPORT RECONCILE ───────────────────────────────────────────────
    // POST /api/fuel/reconcile
    // Body: { driver, base64, mediaType, confirm?:bool }
    //   confirm omitted/false  -> PREVIEW ONLY: parse report, build plan, write
    //                             nothing. Returns { preview:true, plan, summary }.
    //   confirm:true           -> apply the plan (correct amounts, attach invoice
    //                             numbers, insert missing stops). Returns
    //                             { applied:true, summary }.
    //
    // Match key priority: invoice_number, then entry_date + bucket (truck/refer).
    // Report is source of truth for the CHARGED amount; estimates get corrected.
    if (path === '/api/fuel/reconcile' && request.method === 'POST') {
      try {
        const b = await request.json();
        const driver = (b.driver || '').toUpperCase();
        if (!driver) return json({ error: 'Missing driver' }, 400);
        if (!b.base64 || !b.mediaType) return json({ error: 'Missing base64/mediaType' }, 400);
        if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not set in Worker secrets' }, 500);

        // 1. Ask Claude to parse the fuel-card Transaction Report into strict JSON.
        const isPdf = b.mediaType === 'application/pdf';
        const contentBlock = isPdf
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b.base64 } }
          : { type: 'image',    source: { type: 'base64', media_type: b.mediaType || 'image/jpeg', data: b.base64 } };
        const headers = {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        };
        if (isPdf) headers['anthropic-beta'] = 'pdfs-2024-09-25';
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers,
          body: JSON.stringify({
            model: 'claude-sonnet-4-6', max_tokens: 4096,
            messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: getPrompt('fuel-report') }] }],
          }),
        });
        const rawResp = await res.text();
        if (!res.ok) {
          let etype = '', emsg = '';
          try { const ej = JSON.parse(rawResp); etype = ej?.error?.type||''; emsg = ej?.error?.message||''; } catch {}
          return json({ error: 'Claude API error', status: res.status, detail: (etype+': '+emsg) || rawResp.slice(0,300) }, 502);
        }
        const aiData = JSON.parse(rawResp);
        let txt = aiData?.content?.[0]?.text ?? '';
        // Strip any markdown fences the model may add.
        txt = txt.replace(/```json/gi, '').replace(/```/g, '').trim();
        let parsed;
        try { parsed = JSON.parse(txt); }
        catch (e) { return json({ error: 'Could not parse report JSON', detail: txt.slice(0, 400) }, 502); }
        const stops = Array.isArray(parsed) ? parsed : (parsed.stops || []);
        if (!stops.length) return json({ error: 'No fuel stops found in report' }, 422);

        // 2. Load this driver's existing entries.
        const { results: existing } = await env.DB.prepare(
          'SELECT id, entry_date, amount, fuel_type, notes, invoice_number, reconciled FROM fuel_entries WHERE tenant_id=? AND driver=?'
        ).bind(T, driver).all();

        const round2 = (n) => Math.round((parseFloat(n)||0) * 100) / 100;
        const bucketOf = (row) => {
          const n = (row.notes || '').toLowerCase();
          if (row.fuel_type === 'refer' || n.includes('refer') || n.includes('reefer')) return 'refer';
          return 'truck';
        };

        const plan = { correct: [], add: [], verified: [], unmatched_app: [] };
        const usedIds = new Set();

        for (const s of stops) {
          const date = (s.date || '').trim();
          const invoice = String(s.invoice || '').trim();
          const truck = round2(s.truck_total || 0);
          const refer = round2(s.refer_total || 0);
          const def   = round2(s.def_total || 0);
          const card4 = String(s.card_last4 || '').trim();
          const gals  = round2(s.gallons || 0);
          // Truck bucket carries its DEF (report DEFD sits with the truck stop).
          const truckAmt = round2(truck + def);

          const buckets = [];
          if (truckAmt > 0) buckets.push({ bucket: 'truck', amount: truckAmt, fuel_type: 'fleet' });
          if (refer   > 0) buckets.push({ bucket: 'refer', amount: refer,   fuel_type: 'refer' });

          for (const bk of buckets) {
            // (a) exact invoice match first
            let match = existing.find(r => !usedIds.has(r.id) && invoice && r.invoice_number === invoice && bucketOf(r) === bk.bucket);
            // (b) fall back to date + bucket
            if (!match) match = existing.find(r => !usedIds.has(r.id) && r.entry_date === date && bucketOf(r) === bk.bucket);

            if (match) {
              usedIds.add(match.id);
              if (round2(match.amount) === bk.amount && match.invoice_number === invoice) {
                plan.verified.push({ id: match.id, date, invoice, amount: bk.amount, bucket: bk.bucket });
              } else {
                plan.correct.push({
                  id: match.id, date, invoice, bucket: bk.bucket,
                  old_amount: round2(match.amount), new_amount: bk.amount,
                  gallons: gals, card_last4: card4,
                });
              }
            } else {
              plan.add.push({
                date, invoice, bucket: bk.bucket, amount: bk.amount,
                fuel_type: bk.fuel_type, gallons: gals, card_last4: card4,
              });
            }
          }
        }

        // Any app rows never touched by the report = flagged for your review.
        for (const r of existing) {
          if (!usedIds.has(r.id)) {
            plan.unmatched_app.push({
              id: r.id, date: r.entry_date, amount: round2(r.amount),
              bucket: bucketOf(r), notes: r.notes || '',
            });
          }
        }

        const summary = {
          driver,
          report_stops: stops.length,
          to_correct: plan.correct.length,
          to_add: plan.add.length,
          already_verified: plan.verified.length,
          unmatched_app_rows: plan.unmatched_app.length,
        };

        // 3. PREVIEW: return the plan, write nothing.
        if (!b.confirm) return json({ preview: true, summary, plan });

        // 4. CONFIRM: apply corrections + inserts.
        for (const c of plan.correct) {
          await env.DB.prepare(
            'UPDATE fuel_entries SET amount=?, report_amount=?, invoice_number=?, gallons=?, card_last4=?, reconciled=1, ' +
            "notes = CASE WHEN notes IS NULL OR notes='' THEN 'Reconciled from fuel report' ELSE notes || ' | reconciled' END " +
            'WHERE id=? AND tenant_id=?'
          ).bind(c.new_amount, c.new_amount, c.invoice, c.gallons, c.card_last4, c.id, T).run();
        }
        for (const a of plan.add) {
          const nid = crypto.randomUUID();
          await env.DB.prepare(`
            INSERT INTO fuel_entries
              (id, tenant_id, driver, entry_date, amount, fuel_type, notes, receipt_url,
               invoice_number, gallons, card_last4, report_amount, reconciled, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,datetime('now'))
          `).bind(
            nid, T, driver, a.date, a.amount, a.fuel_type,
            'Added from fuel report', '',
            a.invoice, a.gallons, a.card_last4, a.amount
          ).run();
        }
        return json({ applied: true, summary });
      } catch (e) {
        return json({ error: 'Reconcile exception', detail: e.message }, 500);
      }
    }

    if (path.startsWith('/api/fuel-receipt/') && request.method === 'POST') {
      try {
        const entryId = path.split('/')[3];
        if (!env.R2) return json({ error: 'R2 not configured' }, 500);
        const owns = await env.DB.prepare('SELECT id FROM fuel_entries WHERE id=? AND tenant_id=?').bind(entryId, T).first();
        if (!owns) return json({ error: 'Entry not found' }, 404);
        const { base64, mediaType } = await request.json();
        const binary = atob(base64); const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const ext = mediaType === 'application/pdf' ? 'pdf' : 'jpg';
        await env.R2.put(T + '/fuel/' + entryId + '.' + ext, bytes, { httpMetadata: { contentType: mediaType } });
        const receiptUrl = '/api/fuel-receipt/' + entryId;
        await env.DB.prepare('UPDATE fuel_entries SET receipt_url=? WHERE id=? AND tenant_id=?').bind(receiptUrl, entryId, T).run();
        return json({ ok: true, url: receiptUrl });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/fuel-receipt/') && request.method === 'GET') {
      try {
        const entryId = path.split('/')[3];
        if (!env.R2) return json({ error: 'R2 not configured' }, 500);
        const owns = await env.DB.prepare('SELECT id FROM fuel_entries WHERE id=? AND tenant_id=?').bind(entryId, T).first();
        if (!owns) return new Response('Receipt not found', { status: 404, headers: CORS });
        let object = await env.R2.get(T + '/fuel/' + entryId + '.jpg');
        let contentType = 'image/jpeg';
        if (!object) { object = await env.R2.get(T + '/fuel/' + entryId + '.pdf'); contentType = 'application/pdf'; }
        if (object) {
          return new Response(object.body, {
            headers: { ...CORS, 'Content-Type': contentType, 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=3600' },
          });
        }
        const v4 = await getV4Receipt(env, 'fuel-receipt', entryId);
        if (!v4) return new Response('Receipt not found', { status: 404, headers: CORS });
        return new Response(v4.body, {
          headers: { ...CORS, 'Content-Type': v4.contentType || 'image/jpeg', 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=3600' },
        });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path === '/api/brokers' && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare(
          'SELECT * FROM brokers WHERE tenant_id=? ORDER BY broker_name ASC'
        ).bind(T).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path === '/api/brokers' && request.method === 'POST') {
      try {
        const b = await request.json();
        if (!b.broker_name || !b.broker_name.trim()) return json({ error: 'broker_name is required' }, 400);
        const existing = await env.DB.prepare(
          'SELECT id FROM brokers WHERE tenant_id=? AND UPPER(broker_name) = UPPER(?)'
        ).bind(T, b.broker_name.trim()).first();
        if (existing) {
          await env.DB.prepare(`
            UPDATE brokers SET
              broker_mc=?, broker_phone=?, broker_email=?,
              broker_contact=?, broker_address=?, notes=?,
              updated_at=datetime('now')
            WHERE id=? AND tenant_id=?
          `).bind(
            b.broker_mc||'', b.broker_phone||'', b.broker_email||'',
            b.broker_contact||'', b.broker_address||'', b.notes||'',
            existing.id, T,
          ).run();
          return json({ id: existing.id, updated: true });
        }
        const id = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO brokers
            (id, tenant_id, broker_name, broker_mc, broker_phone, broker_email,
             broker_contact, broker_address, notes, total_loads, total_gross,
             created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,'',0,0,datetime('now'),datetime('now'))
        `).bind(
          id, T, b.broker_name.trim(),
          b.broker_mc||'', b.broker_phone||'', b.broker_email||'',
          b.broker_contact||'', b.broker_address||'',
        ).run();
        return json({ id, updated: false });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/brokers/') && path.endsWith('/loads') && request.method === 'GET') {
      try {
        const brokerId = path.split('/')[3];
        const period = url.searchParams.get('period') || 'all';
        const driver = url.searchParams.get('driver') || '';
        let dateFilter = '';
        if (period === 'week')  dateFilter = "AND date(delivery_date) >= date('now', '-7 days')";
        if (period === 'month') dateFilter = "AND date(delivery_date) >= date('now', 'start of month')";
        if (period === 'year')  dateFilter = "AND date(delivery_date) >= date('now', 'start of year')";
        let driverFilter = '';
        const driverVals = [];
        if (driver) { driverFilter = 'AND UPPER(driver) = ?'; driverVals.push(driver.toUpperCase()); }
        const query = `
          SELECT * FROM loads
          WHERE tenant_id = ? AND broker_id = ?
          ${dateFilter}
          ${driverFilter}
          ORDER BY delivery_date DESC, created_at DESC
        `;
        const { results } = await env.DB.prepare(query).bind(T, brokerId, ...driverVals).all();
        const totalLoads = results.length;
        const totalGross = results.reduce((sum, l) => sum + (parseFloat(l.base_pay) || 0), 0);
        return json({ loads: results, totalLoads, totalGross });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/brokers/') && path.split('/').length === 4 && request.method === 'PATCH') {
      try {
        const id = path.split('/')[3];
        const b = await request.json();
        const fields = []; const values = [];
        const allowed = ['broker_name','broker_mc','broker_phone','broker_email','broker_contact','broker_address','notes'];
        allowed.forEach(key => {
          if (b[key] !== undefined) { fields.push(key + '=?'); values.push(b[key]); }
        });
        if (fields.length === 0) return json({ error: 'Nothing to update' }, 400);
        fields.push("updated_at=datetime('now')");
        values.push(id, T);
        await env.DB.prepare('UPDATE brokers SET ' + fields.join(', ') + ' WHERE id=? AND tenant_id=?').bind(...values).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/brokers/') && path.split('/').length === 4 && request.method === 'DELETE') {
      try {
        const id = path.split('/')[3];
        const row = await env.DB.prepare('SELECT id FROM brokers WHERE id=? AND tenant_id=?').bind(id, T).first();
        if (!row) return json({ error: 'Broker not found' }, 404);
        await env.DB.prepare('DELETE FROM brokers WHERE id=? AND tenant_id=?').bind(id, T).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path === '/api/tenant/settings' && request.method === 'GET') {
      try {
        const row = await env.DB.prepare(
          `SELECT id, company_name, slug, status, driver_split_pct,
                  display_name, logo_url, brand_color, support_email,
                  legal_name, mc_number, dot_number, remit_address, remit_email
           FROM tenants WHERE id = ?`
        ).bind(T).first();
        if (!row) return json({ error: 'Tenant not found' }, 404);
        return json(row);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path === '/api/tenant/settings' && request.method === 'PATCH') {
      try {
        if (ctx.role !== 'owner') return json({ error: 'Only the owner can change company settings' }, 403);
        const b = await request.json();
        const fields = []; const values = [];

        if (b.driver_split_pct !== undefined) {
          let pct = Number(b.driver_split_pct);
          if (isNaN(pct)) return json({ error: 'driver_split_pct must be a number' }, 400);
          if (pct > 0 && pct < 1) pct = pct * 100;
          if (pct < 1)  pct = 1;
          if (pct > 50) pct = 50;
          fields.push('driver_split_pct=?'); values.push(pct);
        }

        const textFields = ['display_name','logo_url','brand_color','support_email',
                            'legal_name','mc_number','dot_number','remit_address','remit_email'];
        textFields.forEach(key => {
          if (b[key] !== undefined) { fields.push(key + '=?'); values.push(String(b[key])); }
        });

        if (fields.length === 0) return json({ error: 'Nothing to update' }, 400);
        fields.push("updated_at=datetime('now')");
        values.push(T);
        await env.DB.prepare('UPDATE tenants SET ' + fields.join(', ') + ' WHERE id=?').bind(...values).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path === '/api/drivers' && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare(
          'SELECT * FROM drivers WHERE tenant_id=? ORDER BY active DESC, name ASC'
        ).bind(T).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path === '/api/drivers' && request.method === 'POST') {
      try {
        if (ctx.role !== 'owner' && ctx.role !== 'bookkeeper') return json({ error: 'Not authorized' }, 403);
        const b = await request.json();
        if (!b.name || !b.name.trim()) return json({ error: 'name is required' }, 400);
        const name = b.name.trim().toUpperCase();
        const existing = await env.DB.prepare(
          'SELECT id FROM drivers WHERE tenant_id=? AND name=?'
        ).bind(T, name).first();
        if (existing) {
          const fields = []; const values = [];
          if (b.display_name      !== undefined) { fields.push('display_name=?');      values.push(String(b.display_name)); }
          if (b.is_owner_operator !== undefined) { fields.push('is_owner_operator=?'); values.push(b.is_owner_operator ? 1 : 0); }
          if (b.color             !== undefined) { fields.push('color=?');             values.push(String(b.color)); }
          if (b.state_label       !== undefined) { fields.push('state_label=?');       values.push(String(b.state_label)); }
          if (b.state_rate        !== undefined) { fields.push('state_rate=?');        values.push(parseFloat(b.state_rate) || 0); }
          if (b.active            !== undefined) { fields.push('active=?');            values.push(b.active ? 1 : 0); }
          if (fields.length === 0) return json({ id: existing.id, updated: true });
          fields.push("updated_at=datetime('now')");
          values.push(existing.id, T);
          await env.DB.prepare('UPDATE drivers SET ' + fields.join(', ') + ' WHERE id=? AND tenant_id=?').bind(...values).run();
          return json({ id: existing.id, updated: true });
        }
        const id = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO drivers
            (id, tenant_id, name, display_name, is_owner_operator, color, state_label, state_rate, active, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
        `).bind(
          id, T, name,
          b.display_name || '',
          b.is_owner_operator ? 1 : 0,
          b.color || '#1e88e5',
          b.state_label || '',
          parseFloat(b.state_rate) || 0,
          b.active === undefined ? 1 : (b.active ? 1 : 0),
        ).run();
        return json({ id, updated: false });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/drivers/') && path.split('/').length === 4 && request.method === 'PATCH') {
      try {
        if (ctx.role !== 'owner' && ctx.role !== 'bookkeeper') return json({ error: 'Not authorized' }, 403);
        const id = path.split('/')[3];
        const b = await request.json();
        const fields = []; const values = [];
        if (b.name              !== undefined) { fields.push('name=?');              values.push(String(b.name).trim().toUpperCase()); }
        if (b.display_name      !== undefined) { fields.push('display_name=?');      values.push(String(b.display_name)); }
        if (b.is_owner_operator !== undefined) { fields.push('is_owner_operator=?'); values.push(b.is_owner_operator ? 1 : 0); }
        if (b.color             !== undefined) { fields.push('color=?');             values.push(String(b.color)); }
        if (b.state_label       !== undefined) { fields.push('state_label=?');       values.push(String(b.state_label)); }
        if (b.state_rate        !== undefined) { fields.push('state_rate=?');        values.push(parseFloat(b.state_rate) || 0); }
        if (b.active            !== undefined) { fields.push('active=?');            values.push(b.active ? 1 : 0); }
        if (fields.length === 0) return json({ error: 'Nothing to update' }, 400);
        fields.push("updated_at=datetime('now')");
        values.push(id, T);
        await env.DB.prepare('UPDATE drivers SET ' + fields.join(', ') + ' WHERE id=? AND tenant_id=?').bind(...values).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/drivers/') && path.split('/').length === 4 && request.method === 'DELETE') {
      try {
        if (ctx.role !== 'owner') return json({ error: 'Not authorized' }, 403);
        const id = path.split('/')[3];
        const row = await env.DB.prepare('SELECT id FROM drivers WHERE id=? AND tenant_id=?').bind(id, T).first();
        if (!row) return json({ error: 'Driver not found' }, 404);
        await env.DB.prepare('DELETE FROM drivers WHERE id=? AND tenant_id=?').bind(id, T).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/carrier-advances/') && request.method === 'GET') {
      try {
        const driver = path.split('/')[3].toUpperCase();
        const { results } = await env.DB.prepare(
          'SELECT * FROM carrier_advances WHERE tenant_id=? AND driver=? ORDER BY advance_date DESC, created_at DESC LIMIT 500'
        ).bind(T, driver).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path === '/api/carrier-advance' && request.method === 'POST') {
      try {
        if (ctx.role !== 'owner' && ctx.role !== 'bookkeeper') return json({ error: 'Not authorized' }, 403);
        const b = await request.json();
        if (!b.driver) return json({ error: 'Missing driver' }, 400);
        const amount = parseFloat(b.amount);
        if (!amount || amount <= 0) return json({ error: 'Invalid amount' }, 400);
        const allowedReasons = ['repair','general','fuel','other'];
        const reason = allowedReasons.includes(b.reason) ? b.reason : 'general';
        const id = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO carrier_advances
            (id, tenant_id, driver, amount, advance_date, reason, notes, asset_id, repaid, repaid_date, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,0,'',datetime('now'),datetime('now'))
        `).bind(
          id, T, b.driver.toUpperCase(), amount,
          b.advance_date || new Date().toISOString().split('T')[0],
          reason, b.notes || '', b.asset_id || '',
        ).run();
        return json({ id });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/carrier-advance/') && path.split('/').length === 4 && request.method === 'PATCH') {
      try {
        if (ctx.role !== 'owner' && ctx.role !== 'bookkeeper') return json({ error: 'Not authorized' }, 403);
        const id = path.split('/')[3];
        const b = await request.json();
        const fields = []; const values = [];
        if (b.amount       !== undefined) { fields.push('amount=?');       values.push(parseFloat(b.amount) || 0); }
        if (b.advance_date !== undefined) { fields.push('advance_date=?'); values.push(String(b.advance_date)); }
        if (b.reason       !== undefined) {
          const allowedReasons = ['repair','general','fuel','other'];
          fields.push('reason=?'); values.push(allowedReasons.includes(b.reason) ? b.reason : 'general');
        }
        if (b.notes        !== undefined) { fields.push('notes=?');        values.push(String(b.notes)); }
        if (b.asset_id     !== undefined) { fields.push('asset_id=?');     values.push(String(b.asset_id)); }
        if (b.repaid       !== undefined) {
          fields.push('repaid=?');      values.push(b.repaid ? 1 : 0);
          fields.push('repaid_date=?'); values.push(b.repaid ? (b.repaid_date || new Date().toISOString().split('T')[0]) : '');
        }
        if (fields.length === 0) return json({ error: 'Nothing to update' }, 400);
        fields.push("updated_at=datetime('now')");
        values.push(id, T);
        await env.DB.prepare('UPDATE carrier_advances SET ' + fields.join(', ') + ' WHERE id=? AND tenant_id=?').bind(...values).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/carrier-advance/') && path.split('/').length === 4 && request.method === 'DELETE') {
      try {
        if (ctx.role !== 'owner' && ctx.role !== 'bookkeeper') return json({ error: 'Not authorized' }, 403);
        const id = path.split('/')[3];
        const row = await env.DB.prepare('SELECT id FROM carrier_advances WHERE id=? AND tenant_id=?').bind(id, T).first();
        if (!row) return json({ error: 'Advance not found' }, 404);
        await env.DB.prepare('DELETE FROM carrier_advances WHERE id=? AND tenant_id=?').bind(id, T).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── RECURRING CHARGES (insurance, plates, payment plans) ─────────────
    // Standing per-week carrier deductions. Mirrors carrier_advances exactly:
    // GET list by driver; POST create; PATCH update; DELETE. Owner/bookkeeper
    // only for writes. The settlement math (recurringChargesForWeek) slices
    // monthly charges to the week and applies the start/end date window.
    if (path.startsWith('/api/recurring-charges/') && request.method === 'GET') {
      try {
        const driver = path.split('/')[3].toUpperCase();
        const { results } = await env.DB.prepare(
          'SELECT * FROM recurring_charges WHERE tenant_id=? AND driver=? ORDER BY active DESC, charge_type ASC, created_at DESC LIMIT 500'
        ).bind(T, driver).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path === '/api/recurring-charge' && request.method === 'POST') {
      try {
        if (ctx.role !== 'owner' && ctx.role !== 'bookkeeper') return json({ error: 'Not authorized' }, 403);
        const b = await request.json();
        if (!b.driver) return json({ error: 'Missing driver' }, 400);
        const amount = parseFloat(b.amount);
        if (!amount || amount <= 0) return json({ error: 'Invalid amount' }, 400);
        const allowedTypes = ['insurance','plates','payment_plan','other'];
        const chargeType = allowedTypes.includes(b.charge_type) ? b.charge_type : 'other';
        const cadence = (b.cadence === 'monthly') ? 'monthly' : 'weekly';
        const id = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO recurring_charges
            (id, tenant_id, driver, charge_type, label, amount, cadence, start_date, end_date, notes, active, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,1,datetime('now'),datetime('now'))
        `).bind(
          id, T, b.driver.toUpperCase(), chargeType,
          (b.label || '').toString().slice(0, 120),
          amount, cadence,
          b.start_date || '', b.end_date || '',
          (b.notes || '').toString().slice(0, 500),
        ).run();
        return json({ id });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/recurring-charge/') && path.split('/').length === 4 && request.method === 'PATCH') {
      try {
        if (ctx.role !== 'owner' && ctx.role !== 'bookkeeper') return json({ error: 'Not authorized' }, 403);
        const id = path.split('/')[3];
        const b = await request.json();
        const fields = []; const values = [];
        if (b.charge_type !== undefined) {
          const allowedTypes = ['insurance','plates','payment_plan','other'];
          fields.push('charge_type=?'); values.push(allowedTypes.includes(b.charge_type) ? b.charge_type : 'other');
        }
        if (b.label       !== undefined) { fields.push('label=?');       values.push(String(b.label).slice(0, 120)); }
        if (b.amount      !== undefined) { fields.push('amount=?');      values.push(parseFloat(b.amount) || 0); }
        if (b.cadence     !== undefined) { fields.push('cadence=?');     values.push(b.cadence === 'monthly' ? 'monthly' : 'weekly'); }
        if (b.start_date  !== undefined) { fields.push('start_date=?');  values.push(String(b.start_date)); }
        if (b.end_date    !== undefined) { fields.push('end_date=?');    values.push(String(b.end_date)); }
        if (b.notes       !== undefined) { fields.push('notes=?');       values.push(String(b.notes).slice(0, 500)); }
        if (b.active      !== undefined) { fields.push('active=?');      values.push(b.active ? 1 : 0); }
        if (fields.length === 0) return json({ error: 'Nothing to update' }, 400);
        fields.push("updated_at=datetime('now')");
        values.push(id, T);
        await env.DB.prepare('UPDATE recurring_charges SET ' + fields.join(', ') + ' WHERE id=? AND tenant_id=?').bind(...values).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/recurring-charge/') && path.split('/').length === 4 && request.method === 'DELETE') {
      try {
        if (ctx.role !== 'owner' && ctx.role !== 'bookkeeper') return json({ error: 'Not authorized' }, 403);
        const id = path.split('/')[3];
        const row = await env.DB.prepare('SELECT id FROM recurring_charges WHERE id=? AND tenant_id=?').bind(id, T).first();
        if (!row) return json({ error: 'Charge not found' }, 404);
        await env.DB.prepare('DELETE FROM recurring_charges WHERE id=? AND tenant_id=?').bind(id, T).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── LOAD STOPS (per-stop geocoded addresses for address-to-address IFTA) ──
    // Child rows of a load: each pickup/delivery with a real address + lat/lon,
    // sequenced in run order. The IFTA mileage engine routes over these coords
    // point-to-point to attribute miles per state. Mirrors the app's tenant-
    // scoped GET/POST/PATCH/DELETE pattern. Geocoding runs on POST (and on PATCH
    // when address fields change) via Nominatim; a stop still saves if geocode
    // misses, and geocoded_at stamps success so misses can be retried later.
    if (path.startsWith('/api/load-stops/') && !path.endsWith('/geocode') && request.method === 'GET') {
      try {
        const loadId = path.split('/')[3];
        const owns = await env.DB.prepare('SELECT id FROM loads WHERE id=? AND tenant_id=?').bind(loadId, T).first();
        if (!owns) return json({ error: 'Load not found' }, 404);
        const { results } = await env.DB.prepare(
          'SELECT * FROM load_stops WHERE tenant_id=? AND load_id=? ORDER BY sequence ASC, created_at ASC'
        ).bind(T, loadId).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path === '/api/load-stop' && request.method === 'POST') {
      try {
        const b = await request.json();
        if (!b.load_id) return json({ error: 'Missing load_id' }, 400);
        const owns = await env.DB.prepare('SELECT id FROM loads WHERE id=? AND tenant_id=?').bind(b.load_id, T).first();
        if (!owns) return json({ error: 'Load not found' }, 404);
        const id = crypto.randomUUID();
        const stopType = (b.stop_type === 'pickup') ? 'pickup' : 'delivery';
        const geo = await geocodeAddress({ address: b.address, city: b.city, state: b.state, zip: b.zip });
        const lat = geo ? geo.lat : null;
        const lon = geo ? geo.lon : null;
        const geocodedAt = geo ? new Date().toISOString() : '';
        await env.DB.prepare(`
          INSERT INTO load_stops
            (id, tenant_id, load_id, sequence, stop_type, address, city, state, zip,
             lat, lon, appointment, geocoded_at, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
        `).bind(
          id, T, b.load_id, parseInt(b.sequence) || 0, stopType,
          b.address || '', b.city || '', (b.state || '').toUpperCase().slice(0, 2), b.zip || '',
          lat, lon, b.appointment || '', geocodedAt,
        ).run();
        return json({ id, geocoded: !!geo, lat, lon });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/load-stop/') && path.split('/').length === 4 && request.method === 'PATCH') {
      try {
        const id = path.split('/')[3];
        const b = await request.json();
        const existing = await env.DB.prepare('SELECT * FROM load_stops WHERE id=? AND tenant_id=?').bind(id, T).first();
        if (!existing) return json({ error: 'Stop not found' }, 404);
        const fields = []; const values = [];
        if (b.sequence    !== undefined) { fields.push('sequence=?');    values.push(parseInt(b.sequence) || 0); }
        if (b.stop_type   !== undefined) { fields.push('stop_type=?');   values.push(b.stop_type === 'pickup' ? 'pickup' : 'delivery'); }
        if (b.address     !== undefined) { fields.push('address=?');     values.push(String(b.address)); }
        if (b.city        !== undefined) { fields.push('city=?');        values.push(String(b.city)); }
        if (b.state       !== undefined) { fields.push('state=?');       values.push(String(b.state).toUpperCase().slice(0, 2)); }
        if (b.zip         !== undefined) { fields.push('zip=?');         values.push(String(b.zip)); }
        if (b.appointment !== undefined) { fields.push('appointment=?'); values.push(String(b.appointment)); }
        // If any address component changed, re-geocode from the merged values.
        const addrChanged = ['address','city','state','zip'].some(k => b[k] !== undefined);
        if (addrChanged) {
          const geo = await geocodeAddress({
            address: b.address !== undefined ? b.address : existing.address,
            city:    b.city    !== undefined ? b.city    : existing.city,
            state:   b.state   !== undefined ? b.state   : existing.state,
            zip:     b.zip     !== undefined ? b.zip     : existing.zip,
          });
          if (geo) {
            fields.push('lat=?');         values.push(geo.lat);
            fields.push('lon=?');         values.push(geo.lon);
            fields.push('geocoded_at=?'); values.push(new Date().toISOString());
          }
        }
        if (fields.length === 0) return json({ error: 'Nothing to update' }, 400);
        fields.push("updated_at=datetime('now')");
        values.push(id, T);
        await env.DB.prepare('UPDATE load_stops SET ' + fields.join(', ') + ' WHERE id=? AND tenant_id=?').bind(...values).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/load-stop/') && path.split('/').length === 4 && request.method === 'DELETE') {
      try {
        const id = path.split('/')[3];
        const row = await env.DB.prepare('SELECT id FROM load_stops WHERE id=? AND tenant_id=?').bind(id, T).first();
        if (!row) return json({ error: 'Stop not found' }, 404);
        await env.DB.prepare('DELETE FROM load_stops WHERE id=? AND tenant_id=?').bind(id, T).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── RE-GEOCODE any stops that missed on first save (retry misses) ────────
    if (path.startsWith('/api/load-stops/') && path.endsWith('/geocode') && request.method === 'POST') {
      try {
        const loadId = path.split('/')[3];
        const owns = await env.DB.prepare('SELECT id FROM loads WHERE id=? AND tenant_id=?').bind(loadId, T).first();
        if (!owns) return json({ error: 'Load not found' }, 404);
        const { results } = await env.DB.prepare(
          "SELECT * FROM load_stops WHERE tenant_id=? AND load_id=? AND (lat IS NULL OR lon IS NULL)"
        ).bind(T, loadId).all();
        let fixed = 0;
        for (const s of results) {
          const geo = await geocodeAddress({ address: s.address, city: s.city, state: s.state, zip: s.zip });
          if (geo) {
            await env.DB.prepare(
              "UPDATE load_stops SET lat=?, lon=?, geocoded_at=?, updated_at=datetime('now') WHERE id=? AND tenant_id=?"
            ).bind(geo.lat, geo.lon, new Date().toISOString(), s.id, T).run();
            fixed++;
          }
        }
        return json({ ok: true, attempted: results.length, fixed });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── ESTIMATED IFTA (routed truck-profile miles, split by state) ──────
    // POST /api/loads/:id/route-ifta
    //   Routes the load's sequenced geocoded stops (load_stops) over real
    //   highways — ORS driving-hgv truck profile when ORS_API_KEY secret is
    //   set, OSRM fallback otherwise — splits the geometry at state lines,
    //   and rewrites this load's ifta_miles rows (loaded legs + the deadhead
    //   leg from the prior load's last stop to this load's first pickup).
    //   Idempotent: safe to re-run after editing stops.
    // GET /api/ifta/:driver?from=&to=
    //   Ongoing estimated IFTA ledger: per-state totals, loaded/deadhead
    //   split, over an optional entry_date window.
    if (path.startsWith('/api/loads/') && path.endsWith('/route-ifta') && request.method === 'POST') {
      try {
        const loadId = path.slice('/api/loads/'.length, -('/route-ifta'.length));
        const out = await handleRouteIfta(env, T, loadId);
        return json(out.body, out.status);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── LIVE MANUAL IFTA (driver-entered state-line odometer chain) ──────
    // POST /api/ifta/manual — the FACT side of IFTA. The driver stamps the
    // odometer at each state line; this writes ifta_segments (source=
    // 'driver-manual') + ifta_miles (source='manual'), replacing this load's
    // routed estimate. Placed BEFORE the generic GET /api/ifta/:driver so the
    // literal path 'manual' is never mistaken for a driver name.
    if (path === '/api/ifta/manual' && request.method === 'POST') {
      try {
        const out = await handleIftaManual(env, T, ctx, request);
        return json(out.body, out.status);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path.startsWith('/api/ifta/') && request.method === 'GET') {
      try {
        const driver = path.split('/')[3];
        if (!driver) return json({ error: 'Missing driver' }, 400);
        const out = await handleIftaSummary(env, T, driver, url);
        return json(out.body, out.status);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path === '/api/contact' && request.method === 'POST') {
      try {
        const b = await request.json();
        const message = (b.message || '').trim();
        if (!message) return json({ error: 'Message is required' }, 400);
        if (message.length > 5000) return json({ error: 'Message is too long (5000 char max)' }, 400);
        const subject = (b.subject || '').toString().slice(0, 200);
        const id = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO contact_messages
            (id, tenant_id, user_id, driver, subject, message, status, created_at)
          VALUES (?,?,?,?,?,?,'open',datetime('now'))
        `).bind(id, T, ctx.user_id, ctx.driver_name || '', subject, message).run();
        return json({ ok: true, id });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (path === '/api/contact' && request.method === 'GET') {
      try {
        if (ctx.role !== 'owner') return json({ error: 'Not authorized' }, 403);
        const { results } = await env.DB.prepare(
          'SELECT * FROM contact_messages WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200'
        ).bind(T).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    return json({ message: 'Load Ledger V5 API — dbappsystems.com' });
  },
};

function getPrompt(mode) {
  const prompts = {
    rateconf: `You are reading a freight rate confirmation document.
Extract ONLY these fields and return ONLY valid JSON, nothing else:
{
  "broker_name": "",
  "broker_mc": "",
  "broker_phone": "",
  "broker_email": "",
  "broker_contact": "",
  "broker_address": "",
  "broker_load_number": "",
  "pickup_location": "",
  "delivery_location": "",
  "pickup_date": "",
  "delivery_date": "",
  "base_pay": "",
  "stops": [
    {"type": "pickup", "address": "", "city": "", "state": "", "zip": "", "date": ""}
  ]
}
Rules:
- base_pay must be a number string like "1250.00" with no dollar sign
- stops must list EVERY pickup and EVERY delivery shown on the document as its own object, in the order the truck runs them (pickups first, then deliveries in the order listed unless the document shows a different run order)
- stop type is exactly "pickup" or "delivery"; address is the street line only; state is the 2-letter code; date as MM/DD/YYYY if shown
- pickup_location stays the FIRST pickup city/state and delivery_location stays the LAST delivery city/state, exactly as before
- broker_mc is the MC number or DOT number of the brokerage (digits only, no "MC" prefix)
- broker_phone is the broker contact phone number
- broker_email is the broker billing or contact email address
- broker_contact is the name of the broker agent or contact person
- broker_address is the broker company address if shown
- pickup_date and delivery_date as MM/DD/YYYY if possible
- Leave any unknown fields as empty string
- Return ONLY the JSON object, no explanation, no markdown`,
    lumper: `This is a lumper receipt for a trucking company.
Look for any dollar amount on this document — it may say Total, Amount, Fee, or just show a number with a dollar sign.
Return ONLY valid JSON, nothing else: {"amount":"0.00"}
amount must be digits only like "125.00" with no dollar sign. If no amount found return {"amount":"0.00"}`,
    express: `This is a Comdata express code or cash advance document used in the trucking industry.
Look for any dollar amount, advance amount, transaction amount, or value on this document.
Return ONLY valid JSON, nothing else: {"amount":"0.00"}
amount must be digits only like "250.00" with no dollar sign. If truly nothing found return {"amount":"0.00"}`,
    incidental: `This is an expense receipt for a truck driver — could be fuel, repair, tolls, or any other expense.
Look for the total amount charged on this receipt.
Return ONLY valid JSON, nothing else: {"amount":"0.00"}
amount must be digits only like "45.00" with no dollar sign. If no amount found return {"amount":"0.00"}`,
    fuel: `This is a fuel receipt or fleet card statement for a truck driver.
Look for the total fuel amount charged — it may say Total, Amount, Fuel Total, Transaction Total, or similar.
Return ONLY valid JSON, nothing else: {"amount":"0.00"}
amount must be digits only like "245.80" with no dollar sign. If no amount found return {"amount":"0.00"}`,
    'fuel-report': `This is a fuel-card Transaction Report for a truck driver (WEX/EFS/Comdata/TCH style). It lists many fueling stops. Each stop has a transaction date, an invoice number, a location, and one or more fuel-type line items (ULSD, ULSR, FUEL, RFR, DEFD) each with quantity and amount.

Group the line items BY STOP (same date + same invoice number). For each stop return one object.

Fuel-type buckets:
- truck_total = sum of ULSD + ULSR + FUEL amounts at that stop
- refer_total = sum of RFR amounts at that stop
- def_total   = sum of DEFD amounts at that stop
- gallons     = total quantity for the stop (all line items)
- card_last4  = last 4 digits of the card number if shown (e.g. "0103")

Ignore per-transaction cash-advance fees (the small $2.00 "Fees" column) — do not add them to any total.

Return ONLY a JSON array, no markdown, no explanation. Each element:
{"date":"YYYY-MM-DD","invoice":"0092887","truck_total":903.09,"refer_total":0,"def_total":0,"gallons":171.82,"card_last4":"0103"}

Dates must be YYYY-MM-DD. Amounts are numbers (no dollar sign). If a bucket has no line items at a stop, use 0.`,
    text: `Extract all visible text from this document. Return plain text only.`,
  };
  return prompts[mode] || null;
}
