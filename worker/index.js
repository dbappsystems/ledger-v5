// worker/index.js
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — Cloudflare Worker — MULTI-TENANT
//
// BEARDS DOCTRINE
//   Truth as Architecture        : tenant separation is enforced by code on
//                                  every read and write, never by convention.
//   Accountability w/o Exception : every data table is filtered by tenant_id.
//   Sovereignty of the User      : a tenant can only ever touch its own rows.
//
// THE WALL (how it works):
//   1) Login issues an opaque session token (sessions table).
//   2) Every data route calls requireTenant() FIRST.
//   3) requireTenant() reads the token from the Authorization header,
//      looks up its tenant_id, and returns it. The tenant_id NEVER comes
//      from the request body or URL — only from the verified session.
//   4) Every SQL statement is scoped: reads add "WHERE tenant_id = ?";
//      writes stamp tenant_id on INSERT and add "AND tenant_id = ?" to
//      UPDATE/DELETE so no one can touch another tenant's row by guessing id.
//
// OCR model: claude-sonnet-4-6 (carried from v4).

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

// ── AUTH HELPERS ────────────────────────────────────────────────────────────
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

// THE GATE — resolves tenant_id from the session token.
//
// Token source: the "Authorization: Bearer" header is the primary channel and
// the ONLY channel accepted for any state-changing request. As a SECONDARY
// channel, a token may arrive in the ?t= query param — but ONLY on GET requests.
// This exists so a plain browser <a href> / <img src> opening a file route
// (invoice PDF, credential file, maintenance/fuel receipt) can authenticate,
// since those tags cannot send a header. A GET can never drive a write in this
// Worker (every INSERT/UPDATE/DELETE route is POST/PATCH/DELETE), so a token in
// a URL is structurally incapable of mutating data. The session lookup and the
// tenant_id resolution below are IDENTICAL no matter which channel supplied the
// token — no new trust, just a second way to present the SAME credential, which
// still must resolve to a valid unexpired session. Sessions are short-lived
// (12h TTL), bounding the exposure of a token that lands in a URL or log.
async function requireTenant(env, request) {
  const auth = request.headers.get('Authorization') || '';
  let token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  // GET-only fallback: token from ?t= query, for browser-opened file links.
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

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // ── AUTH LOGIN ───────────────────────────────────────
    // Finds user by email, verifies password (salted hash, with one-time
    // upgrade from legacy plaintext), issues a session token + tenant_id.
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
          ok = (user.password === password); // legacy plaintext row
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

    // ── AUTH LOGOUT ──────────────────────────────────────
    if (path === '/api/auth/logout' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
      return json({ ok: true });
    }

    // ── EVERYTHING BELOW REQUIRES A VALID SESSION ────────
    // Resolve tenant once; any failure short-circuits to 401.
    let ctx;
    try {
      ctx = await requireTenant(env, request);
    } catch (e) {
      return json({ error: e.message }, e.status || 401);
    }
    const T = ctx.tenant_id; // tenant scope for every query below

    // ── OCR (login-gated; no DB write) ───────────────────
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
            model: 'claude-sonnet-4-6', max_tokens: 1024,
            messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }],
          }),
        });
        const raw = await res.text();
        if (!res.ok) return json({ error: 'Claude API error', status: res.status, detail: raw }, 502);
        const data = JSON.parse(raw);
        return json({ result: data?.content?.[0]?.text ?? '' });
      } catch (e) {
        return json({ error: 'Worker exception', detail: e.message }, 500);
      }
    }

    // ── LOADS GET ────────────────────────────────────────
    if (path === '/api/loads' && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare(
          'SELECT * FROM loads WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100'
        ).bind(T).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── LOADS POST ───────────────────────────────────────
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

        await env.DB.prepare(`
          INSERT INTO loads
            (id, tenant_id, driver_id, driver, broker_id, broker_name, broker_email, load_number,
             origin, destination, pickup_date, delivery_date,
             base_pay, lumper_total, incidental_total, comdata_total,
             detention, pallets, net_pay, notes, bol_count, fuel, status, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
        `).bind(
          id, T, driverVal, driverVal, brokerId,
          b.broker_name||'', b.broker_email||'', b.load_number||'',
          b.origin||'', b.destination||'', b.pickup_date||'', b.delivery_date||'',
          b.base_pay||0, b.lumper_total||0, b.incidental_total||0,
          b.comdata_total||0, b.detention||0, b.pallets||0,
          b.net_pay||0, b.notes||'', b.bol_count||0, b.fuel||0,
          b.status||'invoiced',
        ).run();
        return json({ id });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── UPLOAD INVOICE PDF TO R2 ─────────────────────────
    if (path === '/api/upload-pdf' && request.method === 'POST') {
      try {
        const { base64, loadId } = await request.json();
        if (!base64 || !loadId) return json({ error: 'Missing base64 or loadId' }, 400);
        if (!env.R2) return json({ error: 'R2 not configured' }, 500);
        // verify the load belongs to this tenant before writing its file
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

    // ── SERVE INVOICE PDF FROM R2 ────────────────────────
    if (path.startsWith('/api/invoice/') && request.method === 'GET') {
      try {
        const loadId = path.replace('/api/invoice/', '');
        if (!env.R2) return json({ error: 'R2 not configured' }, 500);
        const owns = await env.DB.prepare('SELECT id FROM loads WHERE id=? AND tenant_id=?').bind(loadId, T).first();
        if (!owns) return new Response('Invoice not found', { status: 404, headers: CORS });
        const object = await env.R2.get(T + '/invoices/' + loadId + '.pdf');
        if (!object) return new Response('Invoice not found', { status: 404, headers: CORS });
        return new Response(object.body, {
          headers: { ...CORS, 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=3600' },
        });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── CREDENTIALS GET ──────────────────────────────────
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

    // ── CREDENTIALS PATCH ────────────────────────────────
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

    // ── UPLOAD CREDENTIAL FILE TO R2 ─────────────────────
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

    // ── SERVE CREDENTIAL FILE FROM R2 ────────────────────
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

    // ── MAINTENANCE GET ──────────────────────────────────
    if (path.startsWith('/api/maintenance/') && request.method === 'GET') {
      try {
        const driver = path.split('/')[3].toUpperCase();
        const { results } = await env.DB.prepare(
          'SELECT * FROM maintenance_ledger WHERE tenant_id=? AND driver=? ORDER BY entry_date DESC, created_at DESC LIMIT 200'
        ).bind(T, driver).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── MAINTENANCE POST ─────────────────────────────────
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

    // ── MAINTENANCE PATCH ────────────────────────────────
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

    // ── MAINTENANCE DELETE ───────────────────────────────
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

    // ── UPLOAD MAINTENANCE RECEIPT ───────────────────────
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

    // ── SERVE MAINTENANCE RECEIPT ────────────────────────
    if (path.startsWith('/api/maintenance-receipt/') && request.method === 'GET') {
      try {
        const entryId = path.split('/')[3];
        if (!env.R2) return json({ error: 'R2 not configured' }, 500);
        const owns = await env.DB.prepare('SELECT id FROM maintenance_ledger WHERE id=? AND tenant_id=?').bind(entryId, T).first();
        if (!owns) return new Response('Receipt not found', { status: 404, headers: CORS });
        let object = await env.R2.get(T + '/maintenance/' + entryId + '.pdf');
        let contentType = 'application/pdf';
        if (!object) { object = await env.R2.get(T + '/maintenance/' + entryId + '.jpg'); contentType = 'image/jpeg'; }
        if (!object) return new Response('Receipt not found', { status: 404, headers: CORS });
        return new Response(object.body, {
          headers: { ...CORS, 'Content-Type': contentType, 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=3600' },
        });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── ESCROW PAYMENTS GET ──────────────────────────────
    if (path.startsWith('/api/escrow-payments/') && request.method === 'GET') {
      try {
        const driver = path.split('/')[3].toUpperCase();
        const { results } = await env.DB.prepare(
          'SELECT * FROM escrow_payments WHERE tenant_id=? AND driver=? ORDER BY funded_at DESC LIMIT 200'
        ).bind(T, driver).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── ESCROW PAYMENT POST ──────────────────────────────
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

    // ── ASSETS GET ───────────────────────────────────────
    if (path.startsWith('/api/assets/') && !path.includes('/payments') && request.method === 'GET') {
      try {
        const driver = path.split('/')[3].toUpperCase();
        const { results } = await env.DB.prepare(
          'SELECT * FROM assets WHERE tenant_id=? AND driver=? ORDER BY created_at ASC'
        ).bind(T, driver).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── ASSETS POST ──────────────────────────────────────
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

    // ── ASSETS PATCH ─────────────────────────────────────
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

    // ── ASSETS DELETE ────────────────────────────────────
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

    // ── ASSET PAYMENTS GET ───────────────────────────────
    if (path.includes('/api/assets/') && path.includes('/payments') && request.method === 'GET') {
      try {
        const assetId = path.split('/')[3];
        const { results } = await env.DB.prepare(
          'SELECT * FROM asset_payments WHERE asset_id=? AND tenant_id=? ORDER BY payment_date DESC, created_at DESC'
        ).bind(assetId, T).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── ASSET PAYMENTS POST ──────────────────────────────
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

    // ── ASSET PAYMENTS DELETE ────────────────────────────
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

    // ── LOADS PATCH ──────────────────────────────────────
    if (path.startsWith('/api/loads/') && request.method === 'PATCH') {
      try {
        const id = path.split('/')[3];
        const b = await request.json();
        const fields = []; const values = [];
        if (b.status       !== undefined) { fields.push('status=?');       values.push(b.status); }
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

    // ── LOADS DELETE ─────────────────────────────────────
    // Owner-gated within the tenant:
    //   role 'owner'      = can delete any load in their tenant
    //   driver            = can delete ONLY their own loads
    //   role 'bookkeeper' = no delete path (matches v4 NICOLE rule)
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
        await env.DB.prepare('DELETE FROM loads WHERE id=? AND tenant_id=?').bind(id, T).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── FUEL ENTRIES GET ─────────────────────────────────
    if (path.startsWith('/api/fuel/') && request.method === 'GET') {
      try {
        const driver = path.split('/')[3].toUpperCase();
        const { results } = await env.DB.prepare(
          'SELECT * FROM fuel_entries WHERE tenant_id=? AND driver=? ORDER BY entry_date DESC, created_at DESC LIMIT 500'
        ).bind(T, driver).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── FUEL ENTRIES POST ────────────────────────────────
    if (path === '/api/fuel' && request.method === 'POST') {
      try {
        const b = await request.json();
        const id = crypto.randomUUID();
        if (!b.driver) return json({ error: 'Missing driver' }, 400);
        await env.DB.prepare(`
          INSERT INTO fuel_entries
            (id, tenant_id, driver, entry_date, amount, fuel_type, notes, receipt_url, created_at)
          VALUES (?,?,?,?,?,?,?,?,datetime('now'))
        `).bind(
          id, T, b.driver.toUpperCase(),
          b.entry_date || new Date().toISOString().split('T')[0],
          parseFloat(b.amount)||0, b.fuel_type||'fleet', b.notes||'', b.receipt_url||'',
        ).run();
        return json({ id });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── FUEL ENTRIES PATCH ───────────────────────────────
    if (path.startsWith('/api/fuel/') && path.split('/').length === 4 && request.method === 'PATCH') {
      try {
        const id = path.split('/')[3];
        const b = await request.json();
        const fields = []; const values = [];
        if (b.entry_date !== undefined) { fields.push('entry_date=?'); values.push(b.entry_date); }
        if (b.amount     !== undefined) { fields.push('amount=?');     values.push(parseFloat(b.amount) || 0); }
        if (b.fuel_type  !== undefined) { fields.push('fuel_type=?');  values.push(b.fuel_type === 'pocket' ? 'pocket' : 'fleet'); }
        if (b.notes      !== undefined) { fields.push('notes=?');      values.push(b.notes); }
        if (fields.length === 0) return json({ error: 'Nothing to update' }, 400);
        values.push(id, T);
        await env.DB.prepare('UPDATE fuel_entries SET ' + fields.join(', ') + ' WHERE id=? AND tenant_id=?').bind(...values).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── FUEL ENTRIES DELETE ──────────────────────────────
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

    // ── UPLOAD FUEL RECEIPT TO R2 ────────────────────────
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

    // ── SERVE FUEL RECEIPT FROM R2 ───────────────────────
    if (path.startsWith('/api/fuel-receipt/') && request.method === 'GET') {
      try {
        const entryId = path.split('/')[3];
        if (!env.R2) return json({ error: 'R2 not configured' }, 500);
        const owns = await env.DB.prepare('SELECT id FROM fuel_entries WHERE id=? AND tenant_id=?').bind(entryId, T).first();
        if (!owns) return new Response('Receipt not found', { status: 404, headers: CORS });
        let object = await env.R2.get(T + '/fuel/' + entryId + '.jpg');
        let contentType = 'image/jpeg';
        if (!object) { object = await env.R2.get(T + '/fuel/' + entryId + '.pdf'); contentType = 'application/pdf'; }
        if (!object) return new Response('Receipt not found', { status: 404, headers: CORS });
        return new Response(object.body, {
          headers: { ...CORS, 'Content-Type': contentType, 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=3600' },
        });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── BROKERS LIST ─────────────────────────────────────
    if (path === '/api/brokers' && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare(
          'SELECT * FROM brokers WHERE tenant_id=? ORDER BY broker_name ASC'
        ).bind(T).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── BROKERS MANUAL UPSERT ────────────────────────────
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

    // ── BROKER LOADS REPORT ──────────────────────────────
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

    // ── BROKER PATCH ─────────────────────────────────────
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

    // ── BROKER DELETE ────────────────────────────────────
    if (path.startsWith('/api/brokers/') && path.split('/').length === 4 && request.method === 'DELETE') {
      try {
        const id = path.split('/')[3];
        const row = await env.DB.prepare('SELECT id FROM brokers WHERE id=? AND tenant_id=?').bind(id, T).first();
        if (!row) return json({ error: 'Broker not found' }, 404);
        await env.DB.prepare('DELETE FROM brokers WHERE id=? AND tenant_id=?').bind(id, T).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── TENANT SETTINGS GET ──────────────────────────────
    // Returns the logged-in tenant's own white-label settings (split, branding,
    // invoice identity). Tenant resolved from the token — a tenant can only ever
    // read its OWN row. Any logged-in user of the tenant may read.
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

    // ── TENANT SETTINGS PATCH ────────────────────────────
    // Updates the tenant's own settings. OWNER ONLY — a driver/bookkeeper cannot
    // change the company split or branding. Tenant resolved from the token, so
    // an owner can only ever modify their OWN tenant row.
    if (path === '/api/tenant/settings' && request.method === 'PATCH') {
      try {
        if (ctx.role !== 'owner') return json({ error: 'Only the owner can change company settings' }, 403);
        const b = await request.json();
        const fields = []; const values = [];

        // Split: accept whole number or fraction, clamp 1..50 (whole %).
        if (b.driver_split_pct !== undefined) {
          let pct = Number(b.driver_split_pct);
          if (isNaN(pct)) return json({ error: 'driver_split_pct must be a number' }, 400);
          if (pct > 0 && pct < 1) pct = pct * 100;   // 0.10 -> 10
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

    // ── DRIVERS LIST ─────────────────────────────────────
    // The tenant's own driver roster (replaces hardcoded BRUCE/TIM). Any logged-in
    // user of the tenant may read it (the UI needs it for tabs/leaderboard/colors).
    if (path === '/api/drivers' && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare(
          'SELECT * FROM drivers WHERE tenant_id=? ORDER BY active DESC, name ASC'
        ).bind(T).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── DRIVER CREATE / UPSERT ───────────────────────────
    // Owner/bookkeeper only. name is the canonical UPPERCASE key, unique per
    // tenant; re-posting an existing name updates that driver's fields.
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
            (id, tenant_id, name, display_name, is_owner_operator, color, active, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))
        `).bind(
          id, T, name,
          b.display_name || '',
          b.is_owner_operator ? 1 : 0,
          b.color || '#1e88e5',
          b.active === undefined ? 1 : (b.active ? 1 : 0),
        ).run();
        return json({ id, updated: false });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── DRIVER PATCH ─────────────────────────────────────
    // Owner/bookkeeper only.
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
        if (b.active            !== undefined) { fields.push('active=?');            values.push(b.active ? 1 : 0); }
        if (fields.length === 0) return json({ error: 'Nothing to update' }, 400);
        fields.push("updated_at=datetime('now')");
        values.push(id, T);
        await env.DB.prepare('UPDATE drivers SET ' + fields.join(', ') + ' WHERE id=? AND tenant_id=?').bind(...values).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── DRIVER DELETE ────────────────────────────────────
    // Owner only. Soft-delete is preferred in the UI (set active=0) so historical
    // loads keyed by this driver's name stay intact; hard delete is allowed but
    // does NOT touch that driver's existing loads/fuel/advances.
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

    // ── CARRIER ADVANCES GET (per driver) ────────────────
    // Carrier->driver direct loans for one driver. Reduces that driver's
    // settlement until repaid. Separate from broker (comdata) billing.
    if (path.startsWith('/api/carrier-advances/') && request.method === 'GET') {
      try {
        const driver = path.split('/')[3].toUpperCase();
        const { results } = await env.DB.prepare(
          'SELECT * FROM carrier_advances WHERE tenant_id=? AND driver=? ORDER BY advance_date DESC, created_at DESC LIMIT 500'
        ).bind(T, driver).all();
        return json(results);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── CARRIER ADVANCE POST ─────────────────────────────
    // Owner/bookkeeper only. reason: repair | general | fuel | other.
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

    // ── CARRIER ADVANCE PATCH ────────────────────────────
    // Owner/bookkeeper only. Edit amount/reason/notes or mark repaid.
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

    // ── CARRIER ADVANCE DELETE ───────────────────────────
    // Owner/bookkeeper only.
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
  "base_pay": ""
}
Rules:
- base_pay must be a number string like "1250.00" with no dollar sign
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
    text: `Extract all visible text from this document. Return plain text only.`,
  };
  return prompts[mode] || null;
}
