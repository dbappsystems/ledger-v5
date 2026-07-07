// worker/signed.js
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — Signed Asset URLs module.
//
// WHY THIS EXISTS
//   Assets (invoices, receipts, credentials, rate cons) render in the browser
//   as <img>/<iframe>/<a href> — real URLs, not fetch()+Authorization. The old
//   way appended the 12-hour session token as ?t=<token>, which leaks through
//   browser history, server logs, and Referer headers. This module replaces
//   that with a short-lived, non-guessable, tenant-scoped link:
//
//     POST /api/signed-url  { type, id, key?, ttlSeconds? }  -> { url }
//       requireTenant already ran in index.js, so T + ctx are trusted.
//       We RE-VERIFY the caller owns the asset (same checks the display
//       endpoints run), compute the canonical R2 key SERVER-SIDE, store a
//       row mapping a random token -> (tenant_id, r2_key, content_type, expiry),
//       and return /api/signed/<token>.
//
//     GET /api/signed/:token  -> streams the R2 object
//       The token is the bearer of permission. No session needed (so the link
//       works in a plain <img>/<iframe>/new tab). Looked up, expiry-checked,
//       then the stored r2_key is fetched from R2. TTL-only — NOT single-use —
//       so opening a receipt in a new tab (which fires two requests) still works.
//
// SECURITY (Beards: Accountability Without Exception + Sovereignty of the User)
//   - Never trusts a client-supplied path. type+id are validated; the R2 key is
//     computed from DB truth here.
//   - Ownership mirrors the live endpoints: drivers reach only their own rows;
//     owner/bookkeeper reach the tenant's rows, exactly as elsewhere.
//   - The mapping stores no PII beyond tenant_id + the R2 key.
//
// Called from index.js AFTER requireTenant for POST; the GET is public-by-token
// and is dispatched BEFORE requireTenant (see index.js wiring).

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

const TTL_MIN = 30;
const TTL_MAX = 3600;
const TTL_DEFAULT = 300;

function clampTtl(v) {
  const n = parseInt(v, 10);
  if (!n || isNaN(n)) return TTL_DEFAULT;
  return Math.min(Math.max(n, TTL_MIN), TTL_MAX);
}

// Does this R2 key exist? Used to resolve .pdf-vs-.jpg without trusting client.
async function firstExistingKey(env, keys) {
  for (const k of keys) {
    try {
      const head = await env.R2.head(k);
      if (head) return { key: k, contentType: head.httpMetadata?.contentType || '' };
    } catch (_) { /* keep trying */ }
  }
  return null;
}

// Resolve {type,id,key} -> { r2_key, content_type } AFTER verifying ownership.
// Returns { error, status } on any failure so the caller can surface it.
async function resolveOwnedKey(env, T, ctx, type, id, credKey) {
  const roleWide = ctx.role === 'owner' || ctx.role === 'bookkeeper';
  const me = (ctx.driver_name || '').toUpperCase();

  switch (type) {
    // ── Load-attached invoice: {T}/invoices/{loadId}.pdf ──────────────────
    case 'invoice': {
      const row = await env.DB.prepare(
        'SELECT id, driver FROM loads WHERE id=? AND tenant_id=?'
      ).bind(id, T).first();
      if (!row) return { error: 'Load not found', status: 404 };
      if (!roleWide && (row.driver || '').toUpperCase() !== me)
        return { error: 'Not authorized', status: 403 };
      return { r2_key: T + '/invoices/' + id + '.pdf', content_type: 'application/pdf' };
    }

    // ── Load-attached rate con: {T}/ratecons/{loadId}.pdf ─────────────────
    case 'ratecon': {
      const row = await env.DB.prepare(
        'SELECT id, driver FROM loads WHERE id=? AND tenant_id=?'
      ).bind(id, T).first();
      if (!row) return { error: 'Load not found', status: 404 };
      if (!roleWide && (row.driver || '').toUpperCase() !== me)
        return { error: 'Not authorized', status: 403 };
      return { r2_key: T + '/ratecons/' + id + '.pdf', content_type: 'application/pdf' };
    }

    // ── Standalone banked rate con: r2_key stored in rate_confirmations ────
    case 'ratecon-file': {
      const row = await env.DB.prepare(
        'SELECT driver, r2_key, content_type FROM rate_confirmations WHERE id=? AND tenant_id=?'
      ).bind(id, T).first();
      if (!row) return { error: 'Rate con not found', status: 404 };
      if (!roleWide && (row.driver || '').toUpperCase() !== me)
        return { error: 'Not authorized', status: 403 };
      return { r2_key: row.r2_key, content_type: row.content_type || 'application/pdf' };
    }

    // ── Credential file: {T}/credentials/{driver}/{key}.(pdf|jpg) ──────────
    //    id = driver, credKey = which credential. Resolve real ext server-side.
    case 'credential': {
      const driver = (id || '').toUpperCase();
      if (!driver || !credKey) return { error: 'Missing driver or key', status: 400 };
      if (!roleWide && driver !== me) return { error: 'Not authorized', status: 403 };
      const base = T + '/credentials/' + driver + '/' + credKey;
      const found = await firstExistingKey(env, [base + '.pdf', base + '.jpg']);
      if (!found) return { error: 'File not found', status: 404 };
      return {
        r2_key: found.key,
        content_type: found.contentType || (found.key.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'),
      };
    }

    // ── Maintenance receipt: {T}/maintenance/{id}.(pdf|jpg) ────────────────
    case 'maintenance': {
      const row = await env.DB.prepare(
        'SELECT id, driver FROM maintenance_ledger WHERE id=? AND tenant_id=?'
      ).bind(id, T).first();
      if (!row) return { error: 'Entry not found', status: 404 };
      if (!roleWide && (row.driver || '').toUpperCase() !== me)
        return { error: 'Not authorized', status: 403 };
      const base = T + '/maintenance/' + id;
      const found = await firstExistingKey(env, [base + '.pdf', base + '.jpg']);
      if (!found) return { error: 'Receipt not found', status: 404 };
      return {
        r2_key: found.key,
        content_type: found.contentType || (found.key.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'),
      };
    }

    // ── Fuel receipt: {T}/fuel/{id}.(jpg|pdf) ──────────────────────────────
    case 'fuel': {
      const row = await env.DB.prepare(
        'SELECT id, driver FROM fuel_entries WHERE id=? AND tenant_id=?'
      ).bind(id, T).first();
      if (!row) return { error: 'Entry not found', status: 404 };
      if (!roleWide && (row.driver || '').toUpperCase() !== me)
        return { error: 'Not authorized', status: 403 };
      const base = T + '/fuel/' + id;
      const found = await firstExistingKey(env, [base + '.jpg', base + '.pdf']);
      if (!found) return { error: 'Receipt not found', status: 404 };
      return {
        r2_key: found.key,
        content_type: found.contentType || (found.key.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'),
      };
    }

    default:
      return { error: 'Invalid asset type', status: 400 };
  }
}

// POST /api/signed-url — mint a signed link. Runs AFTER requireTenant.
// Returns a Response when it owns the path, else null.
export async function handleSignedMint(request, env, ctx, T, url) {
  if (url.pathname !== '/api/signed-url' || request.method !== 'POST') return null;
  try {
    if (!env.R2) return json({ error: 'R2 not configured' }, 500);
    const b = await request.json();
    const type = (b.type || '').toString();
    const id   = (b.id   || '').toString();
    const key  = (b.key  || '').toString(); // only used for credential
    if (!type || !id) return json({ error: 'Missing type or id' }, 400);

    const resolved = await resolveOwnedKey(env, T, ctx, type, id, key);
    if (resolved.error) return json({ error: resolved.error }, resolved.status || 400);

    const token   = crypto.randomUUID();
    const ttl     = clampTtl(b.ttlSeconds);
    const expires = new Date(Date.now() + ttl * 1000).toISOString();

    await env.DB.prepare(`
      INSERT INTO signed_assets
        (token, tenant_id, r2_key, content_type, asset_type, asset_id, expires_at)
      VALUES (?,?,?,?,?,?,?)
    `).bind(
      token, T, resolved.r2_key, resolved.content_type,
      type, (type === 'credential' ? (id + '/' + key) : id),
      expires,
    ).run();

    return json({ url: '/api/signed/' + token, expires_at: expires });
  } catch (e) {
    return json({ error: 'Could not create signed link' }, 500);
  }
}

// GET /api/signed/:token — stream the object. Public-by-token; dispatched
// BEFORE requireTenant in index.js. Returns a Response when it owns the path,
// else null.
export async function handleSignedServe(request, env, url) {
  if (!url.pathname.startsWith('/api/signed/') || request.method !== 'GET') return null;
  try {
    if (!env.R2) return json({ error: 'R2 not configured' }, 500);
    const token = url.pathname.split('/')[3];
    if (!token) return new Response('Not found', { status: 404, headers: CORS });

    const row = await env.DB.prepare(
      'SELECT tenant_id, r2_key, content_type, asset_type, asset_id, expires_at FROM signed_assets WHERE token=?'
    ).bind(token).first();
    if (!row) return new Response('Not found', { status: 404, headers: CORS });

    if (new Date(row.expires_at) < new Date()) {
      await env.DB.prepare('DELETE FROM signed_assets WHERE token=?').bind(token).run().catch(() => {});
      return new Response('Link expired', { status: 410, headers: CORS });
    }

    const object = await env.R2.get(row.r2_key);
    if (object) {
      return new Response(object.body, {
        headers: {
          ...CORS,
          'Content-Type': row.content_type || object.httpMetadata?.contentType || 'application/octet-stream',
          'Content-Disposition': 'inline',
          'Cache-Control': 'private, max-age=60',
        },
      });
    }

    // V4 FALLBACK (invoices only): migrated loads store their PDF in the legacy
    // V4 bucket (env.R2_V4) at invoices/{loadId}.pdf, not in V5's env.R2. The old
    // direct /api/invoice route had this fallback; the signed-serve path dropped
    // it, 404ing every V4-migrated invoice. Restore it here so the billed
    // document is the on-screen document (Beards: Truth as Architecture).
    if (row.asset_type === 'invoice' && row.asset_id && env.R2_V4) {
      try {
        const v4obj = await env.R2_V4.get('invoices/' + row.asset_id + '.pdf');
        if (v4obj && v4obj.size > 1000) {
          return new Response(v4obj.body, {
            headers: {
              ...CORS,
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'inline',
              'Cache-Control': 'private, max-age=60',
            },
          });
        }
      } catch (_) { /* fall through to 404 */ }
    }

    return new Response('Not found', { status: 404, headers: CORS });
  } catch (e) {
    return new Response('Error', { status: 500, headers: CORS });
  }
}
