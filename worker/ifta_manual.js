// worker/ifta_manual.js
// (c) dbappsystems.com 
// Load Ledger V5 — LIVE driver-entered IFTA state-line odometer chains
//                  + home-anchored ROUND lifecycle (open/close/finalize).
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
//   ROUND LIFECYCLE (see docs/HANDOFF-IFTA-ROUNDS.md):
//     round/open     driver enters home-departure odometer (FACT) -> opens a
//                    round; ifta.js anchors the home->pickup chain to it.
//     round/close    "going home" — routes last drop -> home, appends the
//                    estimated closing deadhead leg, status='closing'.
//     round/finalize driver enters home-ARRIVAL odometer (FACT) -> closes the
//                    round and reconciles the whole round's estimate segments so
//                    sum(round segment miles) === arrival_odo - depart_odo.
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
//   Round finalize reconciles ONLY routed-estimate segments; it never rewrites
//   a driver-manual (fact) segment.
//
// This module owns POST /api/ifta/manual and the /api/ifta/round/* routes and
// returns a plan/result object. index.js routes to it BEFORE the generic GET
// /api/ifta/:driver so 'manual'/'round' are never mistaken for a driver name.

const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

// Labeled fallback ONLY. Real home lives on drivers.home_lat/home_lon.
const DEFAULT_HOME = { lat: 38.885871, lon: -90.130106 };

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

  // If a round is active, stamp its id on the fact rows so the round total
  // includes driver-verified legs too. Optional — null when no round is open.
  const roundId = await activeRoundId(env, T, driver, b.round_id);

  const plan = {
    driver, mode, load_id: loadId, entry_date: entryDate, leg_type: legType,
    first_odometer: chain.firstOdo, last_odometer: chain.lastOdo,
    total_miles: chain.totalMiles,
    round_id: roundId,
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
          odo_start, odo_end, leg_type, source, notes, round_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'driver-manual',?,?,datetime('now'))`
    ).bind(
      crypto.randomUUID(), T, driver, loadId, s.seq, entryDate,
      s.state, s.miles, s.odo_start, s.odo_end, legType,
      mode === 'day' ? 'Live daily odometer chain' : 'Live trip odometer chain',
      roundId,
    ).run();
  }

  for (const [st, mi] of Object.entries(byState)) {
    if (mi <= 0) continue;
    await env.DB.prepare(
      `INSERT INTO ifta_miles
         (id, tenant_id, driver, load_id, entry_date, state, miles, leg_type,
          source, notes, round_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,'manual',?,?,datetime('now'),datetime('now'))`
    ).bind(
      crypto.randomUUID(), T, driver, loadId, entryDate, st, mi, legType,
      'Driver odometer reading at state line (fact — replaces routed estimate)',
      roundId,
    ).run();
  }

  return {
    status: 200,
    body: {
      applied: true,
      driver, mode, load_id: loadId,
      total_miles: chain.totalMiles,
      round_id: roundId,
      states: Object.keys(byState).length,
      segments_written: chain.segments.length,
    },
  };
}

// ── ROUND LIFECYCLE ────────────────────────────────────────────────────────

// Return the id of the driver's active (open|closing) round, or the explicit
// round_id if it belongs to this tenant, or null.
async function activeRoundId(env, T, driver, explicitId) {
  try {
    if (explicitId) {
      const r = await env.DB.prepare(
        'SELECT id FROM ifta_rounds WHERE id=? AND tenant_id=?'
      ).bind(String(explicitId), T).first();
      if (r) return r.id;
    }
    const row = await env.DB.prepare(
      "SELECT id FROM ifta_rounds WHERE tenant_id=? AND driver=? AND status IN ('open','closing') ORDER BY opened_at DESC LIMIT 1"
    ).bind(T, driver).first();
    return row ? row.id : null;
  } catch (_) { return null; }
}

// Read a driver's home coordinate; fall back to the labeled default.
async function getHome(env, T, driver) {
  try {
    const row = await env.DB.prepare(
      'SELECT home_lat, home_lon FROM drivers WHERE tenant_id=? AND UPPER(name)=UPPER(?) AND home_lat IS NOT NULL AND home_lon IS NOT NULL LIMIT 1'
    ).bind(T, driver).first();
    if (row && isFinite(Number(row.home_lat)) && isFinite(Number(row.home_lon))) {
      return { lat: Number(row.home_lat), lon: Number(row.home_lon) };
    }
  } catch (_) { /* fall through */ }
  return { ...DEFAULT_HOME };
}

// POST /api/ifta/round/open
// Body: { driver?, depart_odo, date? }
// Opens a round: snapshots the driver's home coordinate and the FACT
// home-departure odometer. Only one open/closing round per driver at a time;
// if one already exists it is returned (idempotent open).
export async function handleRoundOpen(env, T, ctx, request) {
  let b;
  try { b = await request.json(); } catch { return { status: 400, body: { error: 'Invalid JSON body' } }; }
  const driver = String(b.driver || ctx.driver_name || '').toUpperCase().trim();
  if (!driver) return { status: 400, body: { error: 'Missing driver' } };
  const departOdo = Number(b.depart_odo);
  if (!isFinite(departOdo) || departOdo <= 0) {
    return { status: 422, body: { error: 'depart_odo must be a positive number (odometer leaving home)' } };
  }

  // One active round per driver.
  const existing = await env.DB.prepare(
    "SELECT * FROM ifta_rounds WHERE tenant_id=? AND driver=? AND status IN ('open','closing') ORDER BY opened_at DESC LIMIT 1"
  ).bind(T, driver).first();
  if (existing) {
    return { status: 200, body: { ok: true, already_open: true, round: existing } };
  }

  const home = await getHome(env, T, driver);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO ifta_rounds
       (id, tenant_id, driver, status, home_lat, home_lon, depart_odo, opened_at, notes)
     VALUES (?,?,?,'open',?,?,?,datetime('now'),?)`
  ).bind(id, T, driver, home.lat, home.lon, r1(departOdo), 'Round opened at home').run();

  return {
    status: 200,
    body: { ok: true, round_id: id, driver, depart_odo: r1(departOdo), home },
  };
}

// POST /api/ifta/round/close   ("going home")
// Body: { round_id?, driver? }
// Routes the driver's last chained stop -> home, appends the estimated closing
// deadhead leg (source='routed-estimate', leg_type='deadhead'), sets the round
// status='closing'. The closing leg is ESTIMATE until finalize enters the real
// home-arrival odometer. routeTruck + milesByStateOrdered + buildEstimatedChain
// are passed in from ifta.js by index.js (no circular import).
export async function handleRoundClose(env, T, ctx, request, helpers) {
  let b;
  try { b = await request.json(); } catch { return { status: 400, body: { error: 'Invalid JSON body' } }; }
  const driver = String(b.driver || ctx.driver_name || '').toUpperCase().trim();
  if (!driver) return { status: 400, body: { error: 'Missing driver' } };

  const round = await resolveRound(env, T, driver, b.round_id);
  if (!round) return { status: 404, body: { error: 'No open round to close for this driver' } };
  if (round.status === 'closed') return { status: 409, body: { error: 'Round already closed' } };

  // Last chained point for this round = the segment with the greatest odo_end.
  const lastSeg = await env.DB.prepare(
    `SELECT load_id, state, odo_end FROM ifta_segments
      WHERE tenant_id=? AND driver=? AND round_id=? AND odo_end IS NOT NULL
      ORDER BY odo_end DESC LIMIT 1`
  ).bind(T, driver, round.id).first();
  if (!lastSeg) {
    // No chain yet — nothing to route home from. Just mark closing so finalize
    // can still record the arrival odometer against depart.
    await env.DB.prepare(
      "UPDATE ifta_rounds SET status='closing' WHERE id=? AND tenant_id=?"
    ).bind(round.id, T).run();
    return { status: 200, body: { ok: true, round_id: round.id, closing: true, home_leg: false, note: 'No chained segments yet; round set to closing.' } };
  }

  // Find the geographic point the last segment ended at: use that load's last
  // geocoded stop as the origin of the home leg.
  const lastStop = await env.DB.prepare(
    `SELECT lat, lon FROM load_stops
      WHERE tenant_id=? AND load_id=? AND lat IS NOT NULL AND lon IS NOT NULL
      ORDER BY sequence DESC, created_at DESC LIMIT 1`
  ).bind(T, lastSeg.load_id).first();

  const home = round.home_lat != null && round.home_lon != null
    ? { lat: Number(round.home_lat), lon: Number(round.home_lon) }
    : await getHome(env, T, driver);

  let homeLeg = false;
  let closeInfo = { home_leg: false };
  if (lastStop && helpers && helpers.routeTruck && helpers.milesByStateOrdered && helpers.buildEstimatedChain) {
    const homeRoute = await helpers.routeTruck(env, [
      { lat: lastStop.lat, lon: lastStop.lon },
      { lat: home.lat, lon: home.lon },
    ]);
    if (homeRoute) {
      const ordered = helpers.milesByStateOrdered(homeRoute.line);
      const closeChain = helpers.buildEstimatedChain(lastSeg.odo_end, ordered.runs, 'deadhead');
      if (closeChain.ok) {
        // Store the closing leg under a synthetic load_id tied to the round so
        // it never collides with a real load and reconciles with the round.
        const closeLoadId = 'round-home-' + round.id;
        await env.DB.prepare(
          "DELETE FROM ifta_segments WHERE tenant_id=? AND load_id=? AND source='routed-estimate'"
        ).bind(T, closeLoadId).run();
        await env.DB.prepare('DELETE FROM ifta_miles WHERE tenant_id=? AND load_id=?').bind(T, closeLoadId).run();

        const dateStr = mmddyyyyToday();
        const byState = {};
        for (const s of closeChain.segments) {
          await env.DB.prepare(
            `INSERT INTO ifta_segments
               (id, tenant_id, driver, load_id, seq, entry_date, state, miles,
                odo_start, odo_end, leg_type, source, notes, round_id, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,'routed-estimate',?,?,datetime('now'))`
          ).bind(
            crypto.randomUUID(), T, driver, closeLoadId, s.seq, dateStr,
            s.state, s.miles, s.odo_start, s.odo_end, 'deadhead',
            'Estimated going-home leg — enter home arrival odometer to finalize as fact',
            round.id,
          ).run();
          byState[s.state] = r1((byState[s.state] || 0) + s.miles);
        }
        for (const [st, mi] of Object.entries(byState)) {
          if (mi <= 0) continue;
          await env.DB.prepare(
            `INSERT INTO ifta_miles
               (id, tenant_id, driver, load_id, entry_date, state, miles, leg_type,
                source, notes, round_id, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,'deadhead','estimated',?,?,datetime('now'),datetime('now'))`
          ).bind(
            crypto.randomUUID(), T, driver, closeLoadId, dateStr, st, mi, round.id,
            'Estimated going-home miles (provisional until arrival odometer entered)',
          ).run();
        }
        homeLeg = true;
        closeInfo = {
          home_leg: true,
          close_load_id: closeLoadId,
          estimated_home_arrival_odo: closeChain.lastOdo,
          home_leg_miles: closeChain.totalMiles,
          segments: closeChain.segments,
        };
      }
    }
  }

  await env.DB.prepare(
    "UPDATE ifta_rounds SET status='closing' WHERE id=? AND tenant_id=?"
  ).bind(round.id, T).run();

  return { status: 200, body: { ok: true, round_id: round.id, closing: true, ...closeInfo } };
}

// POST /api/ifta/round/finalize
// Body: { round_id?, driver?, arrival_odo }
// Enters the FACT home-arrival odometer, closes the round, and reconciles: the
// round's ESTIMATE segments (source='routed-estimate') are scaled so that
//   sum(all round segment miles) === arrival_odo - depart_odo   (to 0.1 mi).
// Driver-manual (fact) segments are NEVER scaled — only the estimate remainder
// absorbs the drift, distributed proportionally by each estimate segment's mile
// share. If there are no estimate segments to absorb drift, the round still
// closes and the residual is reported (honest, not hidden).
export async function handleRoundFinalize(env, T, ctx, request) {
  let b;
  try { b = await request.json(); } catch { return { status: 400, body: { error: 'Invalid JSON body' } }; }
  const driver = String(b.driver || ctx.driver_name || '').toUpperCase().trim();
  if (!driver) return { status: 400, body: { error: 'Missing driver' } };
  const arrivalOdo = Number(b.arrival_odo);
  if (!isFinite(arrivalOdo) || arrivalOdo <= 0) {
    return { status: 422, body: { error: 'arrival_odo must be a positive number (odometer arriving home)' } };
  }

  const round = await resolveRound(env, T, driver, b.round_id);
  if (!round) return { status: 404, body: { error: 'No round to finalize for this driver' } };
  if (round.status === 'closed') return { status: 409, body: { error: 'Round already closed' } };
  const departOdo = Number(round.depart_odo);
  if (!isFinite(departOdo) || departOdo <= 0) {
    return { status: 422, body: { error: 'Round has no valid depart_odo; cannot reconcile' } };
  }
  if (arrivalOdo <= departOdo) {
    return { status: 422, body: { error: 'Arrival odometer ' + r1(arrivalOdo) + ' must exceed departure ' + r1(departOdo) } };
  }

  const roundMilesActual = r1(arrivalOdo - departOdo); // FACT total for the round

  // All round segments, split fact vs estimate.
  const { results: segs } = await env.DB.prepare(
    `SELECT id, source, miles FROM ifta_segments
      WHERE tenant_id=? AND driver=? AND round_id=?`
  ).bind(T, driver, round.id).all();

  const factMiles = r1(
    segs.filter((s) => s.source === 'driver-manual').reduce((a, s) => a + (s.miles || 0), 0)
  );
  const estSegs = segs.filter((s) => s.source === 'routed-estimate');
  const estMiles = r1(estSegs.reduce((a, s) => a + (s.miles || 0), 0));

  // The estimate portion must absorb: actual round miles − fact miles already
  // stamped. Scale every estimate segment by (target / current estimate total).
  const estTarget = r1(roundMilesActual - factMiles);
  let reconciled = 0;
  let residual = 0;

  if (estSegs.length > 0 && estMiles > 0 && estTarget > 0) {
    const scale = estTarget / estMiles;
    // Scale each segment; re-chain odo_start/odo_end so the chain stays
    // continuous and the integrity identity holds after scaling.
    let running = null;
    // Re-read estimate segments in chain order to re-stamp odometers.
    const { results: ordered } = await env.DB.prepare(
      `SELECT id, odo_start, odo_end, miles FROM ifta_segments
        WHERE tenant_id=? AND driver=? AND round_id=? AND source='routed-estimate'
        ORDER BY odo_start ASC`
    ).bind(T, driver, round.id).all();

    // Anchor the estimate re-chain at the first estimate segment's original
    // odo_start (its position in the round is preserved; only lengths scale).
    running = ordered.length ? r1(ordered[0].odo_start) : null;
    for (const s of ordered) {
      const newMiles = r1((s.miles || 0) * scale);
      const newStart = r1(running);
      const newEnd = r1(newStart + newMiles);
      await env.DB.prepare(
        `UPDATE ifta_segments
            SET miles=?, odo_start=?, odo_end=?,
                notes = CASE WHEN notes LIKE '%[reconciled]%' THEN notes ELSE notes || ' [reconciled]' END
          WHERE id=? AND tenant_id=?`
      ).bind(newMiles, newStart, newEnd, s.id, T).run();
      running = newEnd;
      reconciled++;
    }
    residual = r1(estTarget - r1(ordered.reduce((a, s) => a + r1((s.miles || 0) * scale), 0)));
  } else {
    // No estimate segments to absorb drift — report the residual honestly.
    residual = r1(roundMilesActual - factMiles - estMiles);
  }

  await env.DB.prepare(
    "UPDATE ifta_rounds SET status='closed', arrival_odo=?, closed_at=datetime('now') WHERE id=? AND tenant_id=?"
  ).bind(r1(arrivalOdo), round.id, T).run();

  return {
    status: 200,
    body: {
      ok: true,
      round_id: round.id,
      status: 'closed',
      depart_odo: r1(departOdo),
      arrival_odo: r1(arrivalOdo),
      round_miles_actual: roundMilesActual,
      fact_miles: factMiles,
      estimate_miles_before: estMiles,
      estimate_target: estTarget,
      segments_reconciled: reconciled,
      residual_miles: residual,
      note: (estSegs.length === 0 || estMiles <= 0)
        ? 'No estimate segments to absorb drift; residual reported, not hidden.'
        : 'Estimate segments scaled so round reconciles to the entered home odometers.',
    },
  };
}

// Resolve a round by explicit id (tenant-scoped) or the driver's active one.
async function resolveRound(env, T, driver, explicitId) {
  if (explicitId) {
    const r = await env.DB.prepare(
      'SELECT * FROM ifta_rounds WHERE id=? AND tenant_id=?'
    ).bind(String(explicitId), T).first();
    if (r) return r;
  }
  return await env.DB.prepare(
    "SELECT * FROM ifta_rounds WHERE tenant_id=? AND driver=? AND status IN ('open','closing') ORDER BY opened_at DESC LIMIT 1"
  ).bind(T, driver).first();
}

// Today's date as MM/DD/YYYY (matches ifta_miles storage).
function mmddyyyyToday() {
  const d = new Date();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return mm + '/' + dd + '/' + d.getUTCFullYear();
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
