// worker/ratecons.js
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — Standalone Rate Confirmations module.
//
// A driver banks a rate con the day it arrives, BEFORE a load exists. It lives
// in rate_confirmations (status='pending') + R2 at
// {tenant}/ratecons/standalone/{id}.pdf. When the load is later scanned/booked,
// PATCH /link sets status='linked' + linked_load_id and it drops off the
// pending list. Driver-walled: a driver only ever sees their own.
//
// Called from index.js AFTER requireTenant, so T (tenant_id) and ctx are trusted.
// Returns a Response when it handles the path, or null to let index.js continue.

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

export async function handleRatecons(request, env, ctx, T, url) {
  const path = url.pathname;

  // POST /api/ratecons  — upload/bank a standalone rate con
  if (path === '/api/ratecons' && request.method === 'POST') {
    try {
      if (!env.R2) return json({ error: 'R2 not configured' }, 500);
      const b = await request.json();
      const driver = (b.driver || ctx.driver_name || '').toUpperCase();
      if (!driver) return json({ error: 'Missing driver' }, 400);
      if (!b.base64) return json({ error: 'Missing file data' }, 400);
      const id = crypto.randomUUID();
      const isPdf = (b.mediaType || 'application/pdf').indexOf('pdf') !== -1;
      const ext = isPdf ? 'pdf' : 'jpg';
      const key = T + '/ratecons/standalone/' + id + '.' + ext;
      const binary = atob(b.base64); const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      await env.R2.put(key, bytes, { httpMetadata: { contentType: b.mediaType || 'application/pdf' } });
      await env.DB.prepare(`
        INSERT INTO rate_confirmations
          (id, tenant_id, driver, broker_name, load_number, notes, r2_key, content_type, status, uploaded_at)
        VALUES (?,?,?,?,?,?,?,?,'pending',datetime('now'))
      `).bind(
        id, T, driver,
        (b.broker_name || '').toString().slice(0, 200),
        (b.load_number || '').toString().slice(0, 60),
        (b.notes || '').toString().slice(0, 500),
        key, b.mediaType || 'application/pdf',
      ).run();
      return json({ ok: true, id });
    } catch (e) { return json({ error: e.message }, 500); }
  }

  // GET /api/ratecons/:driver?status=pending|linked|all
  if (path.startsWith('/api/ratecons/') && !path.endsWith('/link') && path.split('/').length === 4 && request.method === 'GET') {
    try {
      const driver = path.split('/')[3].toUpperCase();
      const st = (url.searchParams.get('status') || 'pending').toLowerCase();
      let sql = 'SELECT id, driver, broker_name, load_number, notes, content_type, status, linked_load_id, uploaded_at, linked_at FROM rate_confirmations WHERE tenant_id=? AND driver=?';
      const binds = [T, driver];
      if (st === 'pending' || st === 'linked') { sql += ' AND status=?'; binds.push(st); }
      sql += ' ORDER BY uploaded_at DESC LIMIT 500';
      const { results } = await env.DB.prepare(sql).bind(...binds).all();
      return json(results);
    } catch (e) { return json({ error: e.message }, 500); }
  }

  // GET /api/ratecon-file/:id  — open the stored standalone rate con
  if (path.startsWith('/api/ratecon-file/') && request.method === 'GET') {
    try {
      if (!env.R2) return json({ error: 'R2 not configured' }, 500);
      const id = path.split('/')[3];
      const row = await env.DB.prepare('SELECT r2_key, content_type FROM rate_confirmations WHERE id=? AND tenant_id=?').bind(id, T).first();
      if (!row) return new Response('Rate con not found', { status: 404, headers: CORS });
      const object = await env.R2.get(row.r2_key);
      if (!object) return new Response('Rate con not found', { status: 404, headers: CORS });
      return new Response(object.body, {
        headers: { ...CORS, 'Content-Type': row.content_type || 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=3600' },
      });
    } catch (e) { return json({ error: e.message }, 500); }
  }

  // PATCH /api/ratecons/:id/link  { load_id } — mark linked, drop off pending
  if (path.startsWith('/api/ratecons/') && path.endsWith('/link') && request.method === 'PATCH') {
    try {
      const id = path.split('/')[3];
      const b = await request.json();
      const row = await env.DB.prepare('SELECT id FROM rate_confirmations WHERE id=? AND tenant_id=?').bind(id, T).first();
      if (!row) return json({ error: 'Rate con not found' }, 404);
      await env.DB.prepare(
        "UPDATE rate_confirmations SET status='linked', linked_load_id=?, linked_at=datetime('now') WHERE id=? AND tenant_id=?"
      ).bind((b.load_id || '').toString(), id, T).run();
      return json({ ok: true });
    } catch (e) { return json({ error: e.message }, 500); }
  }

  // DELETE /api/ratecons/:id  — remove a banked rate con (R2 + row)
  if (path.startsWith('/api/ratecons/') && path.split('/').length === 4 && !path.endsWith('/link') && request.method === 'DELETE') {
    try {
      const id = path.split('/')[3];
      const row = await env.DB.prepare('SELECT r2_key FROM rate_confirmations WHERE id=? AND tenant_id=?').bind(id, T).first();
      if (!row) return json({ error: 'Rate con not found' }, 404);
      if (env.R2 && row.r2_key) await env.R2.delete(row.r2_key).catch(() => {});
      await env.DB.prepare('DELETE FROM rate_confirmations WHERE id=? AND tenant_id=?').bind(id, T).run();
      return json({ ok: true });
    } catch (e) { return json({ error: e.message }, 500); }
  }

  return null; // not a ratecons path — let index.js continue
}
