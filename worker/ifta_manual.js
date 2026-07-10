// worker/ifta_manual.js
// (c) dbappsystems.com 
// Load Ledger V5 — LIVE driver-entered IFTA state-line odometer chains.
//
// WHAT THIS DOES
//   The routed engine (ifta.js) writes ESTIMATED per-state miles from map
//   geometry. This module is the FACT side: the driver's own odometer reading
//   stamped at each state line, entered live in the cab. One chain = one trip
//   (attached to a load) OR one raw day (no load). Each chain is a sequence of
//   state rows; the reading that ENDS one state's miles OPENS the next.
//
//   Writes to TWO tables so the existing card + IVDR CSV pick it up untouched:
//     ifta_segments  source='driver-manual'  — the per-line IVDR chain
//     ifta_miles     source='manual'         — per-state mile totals (the
//                                               ledger the quarterly card sums)
//
// CHAIN INTEGRITY (Accountability Without Exception — enforced here, not
// trusted from the client):
//   • odometer readings must STRICTLY INCREASE down the chain
//   • each segment's odo_start === the previous segment's odo_end
//   • miles = odo_end − odo_start, computed server-side (never hand-typed)
//   • the SUM of a chain's segment miles === (last reading − first reading),
//     to the tenth of a mile — the fact-side twin of the routed integrity rule
//
// FACT OVER ESTIMATE (Truth as Architecture):
//   When a manual chain is saved for a LOAD, this DELETEs that load's prior
//   ifta_miles/ifta_segments rows (routed OR manual) and rewrites them from
//   the driver's readings. The driver's odometer outranks the map estimate.
//   A DAILY chain (no load) is stored under a synthetic load_id 'manual-day-
//   {date}' so it lives beside loads without colliding; re-saving the same
//   day replaces that day's manual rows only.
//
// This module owns POST /api/ifta/manual and returns a plan/result object.
// index.js routes to it BEFORE the generic GET /api/ifta/:driver so the word
// 'manual' is never mistaken for a driver name.

const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

// Normalize a client-submitted chain into validated, ordered segments.
// Input row shape: { state:'IL', odometer:1021455 }  (odometer = reading AT the
// line that CLOSES this row's state). The first row also carries start_odometer
// (reading when the chain began). Everything else is derived here.
//
// Returns { ok:true, segments:[...], firstOdo, lastOdo, totalMiles } or
// { ok:false, error }.
function buildChain(startOdo, rows) {
  const s0 = Number(startOdo);
  if (!isFinite(s0) || s0 <= 0) return { ok: false, error: 'Start odometer must be a positive number' };
  if (!Array.isArray(rows) || rows.length < 1) return { ok: false, error: 'Add at least one state row' };

  const segments = [];
  let prevOdo = s0;
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] || {};
    const st = String(raw.state || '').toUpperCase().trim().slice(0, 2);
    const end = Number(raw.odometer);
    if (!/^[A-Z]{2}$/.test(st)) return { ok: false, error: 'Row ' + (i + 1) + ': pick a 2-letter state' };
    if (!isFinite(end)) return { ok: false, error: 'Row ' + (i + 1) + ' (' + st + '): enter the odometer reading at the state line' };
    if (end <= prevOdo) {
      return {
        ok: false,
        error: 'Row ' + (i + 1) + ' (' + st + '): odometer ' + end +
               ' must be greater than the previous reading ' + prevOdo +
               ' — the odometer only moves forward.',
      };
    }
    const miles = r1(end - prevOdo);
    segments.push({ seq: i + 1, state: st, odo_start: r1(prevOdo), odo_end: r1(end), miles });
    prevOdo = end;
  }

  const firstOdo = r1(s0);
  const lastOdo = r1(prevOdo);
  const totalMiles = r1(lastOdo - firstOdo);
  // Integrity check: segment miles must sum to the odometer delta.
  const sumSeg = r1(segments.reduce((a, s) => a + s.miles, 0));
  if (sumSeg !== totalMiles) {
    return { ok: false, error: 'Chain integrity failed: segment miles ' + sumSeg + ' ≠ odometer delta ' + totalMiles };
  }
  return { ok: true, segments, firstOdo, lastOdo, totalMiles };
}

// POST /api/ifta/manual
// Body:
//   { driver, mode:'load'|'day', load_id?, date, leg_type?, start_odometer,
//     rows:[{state,odometer},...], confirm?:bool }
//   confirm omitted/false -> PREVIEW: validate + return the plan, write nothing.
//   confirm:true          -> apply: rewrite ifta_segments + ifta_miles for this
//                            load_id (fact replaces estimate).
export async function handleIftaManual(env, T, ctx, request) {
  let b;
  try { b = await request.json(); } catch { return { status: 400, body: { error: 'Invalid JSON body' } }; }

  const driver = String(b.driver || ctx.driver_name || '').toUpperCase().trim();
  if (!driver) return { status: 400, body: { error: 'Missing driver' } };

  const mode = b.mode === 'day' ? 'day' : 'load';
  const legType = b.leg_type === 'deadhead' ? 'deadhead' : 'loaded';
  // entry_date stored MM/DD/YYYY to match ifta_miles (the quarterly card parses
  // year via substr(7,4) / month via substr(1,2) — see ifta.js). Accept either
  // MM/DD/YYYY or YYYY-MM-DD from the client and normalize to MM/DD/YYYY.
  const entryDate = normalizeDate(b.date);
  if (!entryDate) return { status: 400, body: { error: 'Provide a valid date (MM/DD/YYYY)' } };

  // Resolve the load_id the chain writes under.
  let loadId;
  if (mode === 'load') {
    loadId = String(b.load_id || '').trim();
    if (!loadId) return { status: 400, body: { error: 'Load mode needs a load_id (or switch to day mode)' } };
    const owns = await env.DB.prepare(
      'SELECT id, driver FROM loads WHERE id=? AND tenant_id=?'
    ).bind(loadId, T).first();
    if (!owns) return { status: 404, body: { error: 'Load not found' } };
    // Driver may only log their own load unless owner/bookkeeper.
    if (ctx.role !== 'owner' && ctx.role !== 'bookkeeper' &&
        String(owns.driver || '').toUpperCase() !== driver) {
      return { status: 403, body: { error: 'Not authorized for this load' } };
    }
  } else {
    // Daily chain — synthetic, collision-free id keyed by driver + date.
    loadId = 'manual-day-' + driver + '-' + entryDate.replace(/\//g, '');
  }

  const chain = buildChain(b.start_odometer, b.rows);
  if (!chain.ok) return { status: 422, body: { error: chain.error } };

  // Per-state mile totals for the ifta_miles ledger (a chain can touch a state
  // more than once — e.g. IL → IN → IL — so sum by state).
  const byState = {};
  for (const s of chain.segments) byState[s.state] = r1((byState[s.state] || 0) + s.miles);

  const plan = {
    driver, mode, load_id: loadId, entry_date: entryDate, leg_type: legType,
    first_odometer: chain.firstOdo, last_odometer: chain.lastOdo,
    total_miles: chain.totalMiles,
    segments: chain.segments,
    by_state: byState,
  };

  // PREVIEW — write nothing.
  if (!b.confirm) return { status: 200, body: { preview: true, plan } };

  // APPLY — fact replaces estimate for this load_id. Idempotent rewrite.
  await env.DB.prepare('DELETE FROM ifta_segments WHERE tenant_id=? AND load_id=?').bind(T, loadId).run();
  await env.DB.prepare('DELETE FROM ifta_miles   WHERE tenant_id=? AND load_id=?').bind(T, loadId).run();

  for (const s of chain.segments) {
    await env.DB.prepare(
      `INSERT INTO ifta_segments
         (id, tenant_id, driver, load_id, seq, entry_date, state, miles,
          odo_start, odo_end, leg_type, source, notes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'driver-manual',?,datetime('now'))`
    ).bind(
      crypto.randomUUID(), T, driver, loadId, s.seq, entryDate,
      s.state, s.miles, s.odo_start, s.odo_end, legType,
      mode === 'day' ? 'Live daily odometer chain' : 'Live trip odometer chain',
    ).run();
  }

  for (const [st, mi] of Object.entries(byState)) {
    if (mi <= 0) continue;
    await env.DB.prepare(
      `INSERT INTO ifta_miles
         (id, tenant_id, driver, load_id, entry_date, state, miles, leg_type,
          source, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,'manual',?,datetime('now'),datetime('now'))`
    ).bind(
      crypto.randomUUID(), T, driver, loadId, entryDate, st, mi, legType,
      'Driver odometer reading at state line (fact — replaces routed estimate)',
    ).run();
  }

  return {
    status: 200,
    body: {
      applied: true,
      driver, mode, load_id: loadId,
      total_miles: chain.totalMiles,
      states: Object.keys(byState).length,
      segments_written: chain.segments.length,
    },
  };
}

// Accept MM/DD/YYYY or YYYY-MM-DD; return MM/DD/YYYY or '' if unparseable.
function normalizeDate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mm = String(m[1]).padStart(2, '0');
    const dd = String(m[2]).padStart(2, '0');
    return mm + '/' + dd + '/' + m[3];
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const mm = String(m[2]).padStart(2, '0');
    const dd = String(m[3]).padStart(2, '0');
    return mm + '/' + dd + '/' + m[1];
  }
  return '';
}
