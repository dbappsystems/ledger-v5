// backup-worker/index.js
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — SCHEDULED D1 -> R2 BACKUP WORKER
//
// WHY THIS EXISTS
//   D1 Time Travel already gives point-in-time recovery for the last 30 days
//   (always on, no setup). This Worker is the SECOND layer: it writes a full
//   SQL dump of the production database into a SEPARATE R2 bucket on a schedule,
//   so backups survive beyond the 30-day Time Travel window and live outside the
//   database itself. See backup-worker/README.md for setup + restore.
//
// SAFETY (this Worker can NOT harm the live app)
//   * It only READS the D1 database (SELECT + PRAGMA + sqlite_master). It issues
//     no INSERT/UPDATE/DELETE/DDL against D1.
//   * It writes ONLY to the backup R2 bucket (env.BACKUP_R2), never to the
//     production files bucket and never to D1.
//   * It is a standalone Worker — it does not touch worker/index.js or any live
//     route, so deploying it cannot break the running API.
//
// TRIGGERS
//   * scheduled() — the cron trigger in wrangler.toml runs the backup.
//   * fetch()     — an OPTIONAL manual trigger / status endpoint, DISABLED unless
//                   the BACKUP_TRIGGER_TOKEN secret is set. Lets Daddyboy kick a
//                   backup or check status from a phone browser.

const BATCH = 5000; // rows per page when dumping a table (safe for growth)

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// SQLite-safe literal for a value returned by the D1 binding.
function sqlVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof ArrayBuffer) {
    // BLOB -> X'..' hex literal. (No blob columns today, but be safe.)
    const bytes = new Uint8Array(v);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return "X'" + hex + "'";
  }
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function ident(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

// Build a full SQL dump: schema (tables) -> data (INSERTs) -> indexes/triggers/views.
async function buildDump(env) {
  const dbName = env.DB_NAME || 'd1';
  const now = new Date();

  // Every user object in the DB, excluding SQLite internals and Cloudflare's own
  // bookkeeping tables (_cf_*). sql IS NULL for auto-created objects — skip those.
  const { results: objects } = await env.DB.prepare(
    "SELECT name, type, sql FROM sqlite_master " +
    "WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' " +
    "ORDER BY name"
  ).all();

  const tables = objects.filter(o => o.type === 'table');
  const post   = objects.filter(o => o.type === 'index' || o.type === 'trigger' || o.type === 'view');

  const out = [];
  out.push('-- Load Ledger V5 — D1 backup');
  out.push('-- database: ' + dbName);
  out.push('-- generated: ' + now.toISOString());
  out.push('-- tables: ' + tables.length);
  out.push('PRAGMA foreign_keys=OFF;');
  out.push('BEGIN TRANSACTION;');

  let totalRows = 0;
  const perTable = {};

  // 1) Schema for every table.
  for (const t of tables) {
    out.push('');
    out.push('-- table: ' + t.name);
    out.push(t.sql.trim() + ';');
  }

  // 2) Data for every table (paginated).
  for (const t of tables) {
    let offset = 0;
    let rows = 0;
    while (true) {
      const { results } = await env.DB.prepare(
        'SELECT * FROM ' + ident(t.name) + ' LIMIT ' + BATCH + ' OFFSET ' + offset
      ).all();
      if (!results || results.length === 0) break;
      if (offset === 0) { out.push(''); out.push('-- data: ' + t.name); }
      const cols = Object.keys(results[0]);
      const colList = cols.map(ident).join(',');
      for (const row of results) {
        const vals = cols.map(c => sqlVal(row[c])).join(',');
        out.push('INSERT INTO ' + ident(t.name) + ' (' + colList + ') VALUES (' + vals + ');');
      }
      rows += results.length;
      offset += results.length;
      if (results.length < BATCH) break;
    }
    perTable[t.name] = rows;
    totalRows += rows;
  }

  // 3) Indexes / triggers / views last (data is already in).
  if (post.length) {
    out.push('');
    out.push('-- indexes, triggers, views');
    for (const o of post) out.push(o.sql.trim() + ';');
  }

  out.push('');
  out.push('COMMIT;');
  out.push('PRAGMA foreign_keys=ON;');
  out.push('');

  return { sql: out.join('\n'), tables: tables.length, totalRows, perTable, generatedAt: now };
}

function keyFor(dbName, d) {
  const p = n => String(n).padStart(2, '0');
  const stamp = d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    '-' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
  return 'd1/' + dbName + '/' + d.getUTCFullYear() + '/' + stamp + '.sql';
}

// Delete dumps older than RETENTION_DAYS so the bucket doesn't grow forever.
async function pruneOld(env) {
  const days = parseInt(env.RETENTION_DAYS || '90', 10);
  if (!days || days <= 0) return { pruned: 0 };
  const cutoff = Date.now() - days * 86400000;
  let cursor;
  let pruned = 0;
  do {
    const listing = await env.BACKUP_R2.list({ prefix: 'd1/', cursor, limit: 1000 });
    for (const obj of listing.objects) {
      const uploaded = obj.uploaded ? new Date(obj.uploaded).getTime() : Date.now();
      if (uploaded < cutoff) { await env.BACKUP_R2.delete(obj.key); pruned++; }
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return { pruned };
}

async function runBackup(env) {
  const dbName = env.DB_NAME || 'd1';
  const dump = await buildDump(env);
  const key = keyFor(dbName, dump.generatedAt);
  const body = dump.sql;
  await env.BACKUP_R2.put(key, body, {
    httpMetadata: { contentType: 'application/sql' },
    customMetadata: {
      tables: String(dump.tables),
      rows: String(dump.totalRows),
      generatedAt: dump.generatedAt.toISOString(),
    },
  });
  const prune = await pruneOld(env);
  return {
    ok: true,
    key,
    bytes: body.length,
    tables: dump.tables,
    rows: dump.totalRows,
    perTable: dump.perTable,
    pruned: prune.pruned,
    generatedAt: dump.generatedAt.toISOString(),
  };
}

async function latestBackups(env, limit = 10) {
  const listing = await env.BACKUP_R2.list({ prefix: 'd1/', limit: 1000 });
  const items = listing.objects
    .map(o => ({ key: o.key, size: o.size, uploaded: o.uploaded }))
    .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded))
    .slice(0, limit);
  return items;
}

export default {
  // Cron-driven backup. ctx.waitUntil keeps the Worker alive until it finishes.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBackup(env).catch(err => console.error('backup failed:', err && err.message)));
  },

  // Optional manual trigger + status. Disabled unless BACKUP_TRIGGER_TOKEN is set.
  async fetch(request, env) {
    const token = env.BACKUP_TRIGGER_TOKEN;
    if (!token) {
      return json({ error: 'Manual trigger disabled. Set the BACKUP_TRIGGER_TOKEN secret to enable /run and /status.' }, 503);
    }
    const url = new URL(request.url);
    const auth = request.headers.get('Authorization') || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const qtoken = (url.searchParams.get('token') || '').trim();
    if (bearer !== token && qtoken !== token) {
      return json({ error: 'Unauthorized' }, 401);
    }

    try {
      if (url.pathname === '/run' || url.pathname === '/run/') {
        const result = await runBackup(env);
        return json(result);
      }
      if (url.pathname === '/status' || url.pathname === '/status/' || url.pathname === '/') {
        return json({ ok: true, latest: await latestBackups(env) });
      }
      return json({ error: 'Not found', endpoints: ['/run', '/status'] }, 404);
    } catch (e) {
      return json({ error: 'Backup error', detail: e && e.message ? e.message : String(e) }, 500);
    }
  },
};
