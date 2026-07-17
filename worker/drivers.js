// worker/drivers.js
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — DRIVERS registry endpoints
//
// Standalone feature module, wired into worker/index.js with a two-line dispatch
// (mirrors ratecons.js / payments.js / signed.js / contact.js). Owns the
// /api/drivers paths and returns a Response when it handles one, else null so
// the host router continues. Extracted verbatim from worker/index.js — no
// behavior change.
//
// The drivers table holds real driver IDs + the is_owner_operator flag; it is
// the successor to the old BRUCE/TIM string-matching. Rows here are registry
// records only — this module never touches loads, settlement math, or pay-side
// state. name is stored UPPERCASE to match loads.driver.
//
// AUTH:
//   * GET:    any authenticated tenant user may list the roster.
//   * POST:   owner or bookkeeper (upsert by tenant_id+name).
//   * PATCH:  owner or bookkeeper.
//   * DELETE: owner only.
//
// TENANT SCOPING: every query is bound with T (ctx.tenant_id). No cross-tenant read.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// handleDrivers(request, env, ctx, T, url)
//   Returns a Response if it owns the path, otherwise null.
export async function handleDrivers(request, env, ctx, T, url) {
  const path = url.pathname;

  // ── GET /api/drivers ───────────────────────────────────────────
  // Any authenticated tenant user may read the roster. Active first, then A→Z.
  if (path === '/api/drivers' && request.method === 'GET') {
    try {
      const { results } = await env.DB.prepare(
        'SELECT * FROM drivers WHERE tenant_id=? ORDER BY active DESC, name ASC'
      ).bind(T).all();
      return json(results);
    } catch (e) { return json({ error: 'Could not load drivers' }, 500); }
  }

  // ── POST /api/drivers ──────────────────────────────────────────
  // Owner/bookkeeper only. Upsert keyed by tenant_id + UPPERCASE name: an
  // existing driver is patched with any provided fields; otherwise a new row
  // is inserted with sensible defaults (color, active=1).
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
    } catch (e) { return json({ error: 'Could not save driver' }, 500); }
  }

  // ── PATCH /api/drivers/:id ─────────────────────────────────────
  // Owner/bookkeeper only. Updates any provided field on one driver row.
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
    } catch (e) { return json({ error: 'Could not update driver' }, 500); }
  }

  // ── DELETE /api/drivers/:id ────────────────────────────────────
  // Owner only. Removes one driver row after confirming tenant ownership.
  if (path.startsWith('/api/drivers/') && path.split('/').length === 4 && request.method === 'DELETE') {
    try {
      if (ctx.role !== 'owner') return json({ error: 'Not authorized' }, 403);
      const id = path.split('/')[3];
      const row = await env.DB.prepare('SELECT id FROM drivers WHERE id=? AND tenant_id=?').bind(id, T).first();
      if (!row) return json({ error: 'Driver not found' }, 404);
      await env.DB.prepare('DELETE FROM drivers WHERE id=? AND tenant_id=?').bind(id, T).run();
      return json({ ok: true });
    } catch (e) { return json({ error: 'Could not delete driver' }, 500); }
  }

  // Not our path — let the host router continue.
  return null;
}
