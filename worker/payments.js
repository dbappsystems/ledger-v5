// worker/payments.js
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — SETTLEMENT PAYMENTS endpoints (carrier -> driver cash/check)
//
// Standalone feature module, wired into worker/index.js with a two-line dispatch
// (mirrors ratecons.js / signed.js). Owns the /api/settlement-payments* paths and
// returns a Response when it handles one, else null so the host router continues.
//
// These rows are the FACT of a cash/check disbursement Edgerton hands the driver.
// The oldest-load-first reconciliation happens client-side in src/settlementFifo.js;
// this module only stores/lists/deletes the payment records. It never touches
// loads, load.status, or the all-time running-balance formula.
//
// AUTH (matches carrier_advances):
//   * POST / DELETE: owner or bookkeeper only.
//   * GET: owner or bookkeeper for any driver; a plain driver only for self.
//
// TENANT SCOPING: every query is bound with T (ctx.tenant_id). No cross-tenant read.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

const ALLOWED_METHODS = ['cash', 'check', 'other'];

// handleSettlementPayments(request, env, ctx, T, url)
//   Returns a Response if it owns the path, otherwise null.
export async function handleSettlementPayments(request, env, ctx, T, url) {
  const path = url.pathname;

  // ── GET /api/settlement-payments/:driver ───────────────────────
  if (path.startsWith('/api/settlement-payments/') && request.method === 'GET') {
    try {
      const driver = decodeURIComponent(path.split('/')[3] || '').toUpperCase();
      if (!driver) return json({ error: 'Missing driver' }, 400);
      // A plain driver may only read their own payments.
      if (ctx.role !== 'owner' && ctx.role !== 'bookkeeper') {
        const self = String(ctx.driver_name || '').toUpperCase();
        if (driver !== self) return json({ error: 'Not authorized' }, 403);
      }
      const { results } = await env.DB.prepare(
        'SELECT * FROM settlement_payments WHERE tenant_id=? AND driver=? ORDER BY paid_at DESC, created_at DESC LIMIT 1000'
      ).bind(T, driver).all();
      return json(results || []);
    } catch (e) { return json({ error: 'Could not load payments' }, 500); }
  }

  // ── POST /api/settlement-payment ───────────────────────────
  if (path === '/api/settlement-payment' && request.method === 'POST') {
    try {
      if (ctx.role !== 'owner' && ctx.role !== 'bookkeeper') return json({ error: 'Not authorized' }, 403);
      const b = await request.json();
      if (!b.driver) return json({ error: 'Missing driver' }, 400);
      const amount = parseFloat(b.amount);
      if (!amount || amount <= 0) return json({ error: 'Invalid amount' }, 400);
      const method = ALLOWED_METHODS.includes(b.method) ? b.method : 'cash';
      const id = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO settlement_payments
          (id, tenant_id, driver, amount, paid_at, method, reference, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
      `).bind(
        id, T, b.driver.toUpperCase(), amount,
        b.paid_at || new Date().toISOString().split('T')[0],
        method, b.reference || '', b.notes || '',
      ).run();
      return json({ id });
    } catch (e) { return json({ error: 'Could not save payment' }, 500); }
  }

  // ── DELETE /api/settlement-payment/:id ───────────────────────
  if (path.startsWith('/api/settlement-payment/') && path.split('/').length === 4 && request.method === 'DELETE') {
    try {
      if (ctx.role !== 'owner' && ctx.role !== 'bookkeeper') return json({ error: 'Not authorized' }, 403);
      const id = path.split('/')[3];
      const row = await env.DB.prepare('SELECT id FROM settlement_payments WHERE id=? AND tenant_id=?').bind(id, T).first();
      if (!row) return json({ error: 'Payment not found' }, 404);
      await env.DB.prepare('DELETE FROM settlement_payments WHERE id=? AND tenant_id=?').bind(id, T).run();
      return json({ ok: true });
    } catch (e) { return json({ error: 'Could not delete payment' }, 500); }
  }

  return null; // not our path
}
