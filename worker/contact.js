// worker/contact.js
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — CONTACT / SUPPORT MESSAGE endpoints
//
// Standalone feature module, wired into worker/index.js with a two-line dispatch
// (mirrors ratecons.js / payments.js / signed.js). Owns the /api/contact paths
// and returns a Response when it handles one, else null so the host router
// continues. Extracted verbatim from worker/index.js — no behavior change.
//
// These rows are inbound support/contact messages from users of a tenant.
// Writes to the contact_messages table only; touches no loads, no settlement
// math, no pay-side state.
//
// AUTH:
//   * POST: any authenticated tenant user may send a message.
//   * GET:  owner only (reads the tenant's message queue, newest first).
//
// TENANT SCOPING: every query is bound with T (ctx.tenant_id). No cross-tenant read.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// handleContact(request, env, ctx, T, url)
//   Returns a Response if it owns the path, otherwise null.
export async function handleContact(request, env, ctx, T, url) {
  const path = url.pathname;

  // ── POST /api/contact ──────────────────────────────────────────
  // Any authenticated tenant user may submit. Message required, capped at
  // 5000 chars; subject is optional and truncated to 200. Stored 'open'.
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
    } catch (e) { return json({ error: 'Could not send message' }, 500); }
  }

  // ── GET /api/contact ───────────────────────────────────────────
  // Owner-only. Returns the tenant's 200 most recent messages, newest first.
  if (path === '/api/contact' && request.method === 'GET') {
    try {
      if (ctx.role !== 'owner') return json({ error: 'Not authorized' }, 403);
      const { results } = await env.DB.prepare(
        'SELECT * FROM contact_messages WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200'
      ).bind(T).all();
      return json(results);
    } catch (e) { return json({ error: 'Could not load messages' }, 500); }
  }

  // Not our path — let the host router continue.
  return null;
}
