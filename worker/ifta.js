// worker/ifta.js
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — ESTIMATED IFTA mileage engine (home-anchored rounds).
//
// WHAT THIS DOES
//   Takes a load's sequenced, geocoded stops (load_stops rows), routes them
//   over real highways with a commercial-truck profile, splits the route
//   geometry at state lines, and writes per-state mile rows into ifta_miles.
//   Computes the DEADHEAD leg: previous stop -> this load's first pickup.
//   When a ROUND is active it also lays an ESTIMATED odometer chain into
//   ifta_segments (source='routed-estimate'), forward-derived from the round's
//   home-departure odometer (see docs/HANDOFF-IFTA-ROUNDS.md).
//
// ROUTING
//   Primary: OpenRouteService driving-hgv (true truck profile). Requires Worker
//   secret ORS_API_KEY. Fallback: public OSRM (car profile) — rows marked
//   source='estimated' vs 'routed' so the ledger names its own confidence.
//
// STATE ATTRIBUTION
//   Route geometry -> point-in-polygon against simplified state boundaries
//   (states.js). Slivers that resolve to no state bucket under 'XX' so the SUM
//   of a load's state rows ALWAYS equals its routed total. No silent mile loss.
//
// HOME-ANCHORED ROUND (Path C)
//   A round = home -> loads -> home, bracketed by two REAL odometer readings the
//   driver enters at home (depart_odo opens, arrival_odo finalizes). Between
//   them every estimated odometer value is forward-derived: anchor + routed
//   miles. Deadhead legs:
//     • home -> first pickup : first load of a round, anchored by round depart_odo
//     • drop -> next pickup  : continuation, anchored by prior load's odo_end
//     • last drop -> home    : the "going home" leg (round/close), see ifta.js
//   Estimate NEVER outranks fact: a load with any driver-manual segment hides
//   its routed-estimate segments in the summary, and the manual apply deletes a
//   load's segments before writing fact. Promotion estimate->fact goes through
//   the single write path POST /api/ifta/manual.
//
// INTEGRITY RULE (Accountability Without Exception)
//   Per chain: sum(seg miles) === lastOdo - firstOdo, to 0.1 mi.
//   Per load : sum(ifta_miles.miles) === routed total, to 0.1 mi.

import { STATES } from './states.js';

// Labeled fallback ONLY. Real home lives on drivers.home_lat/home_lon; this is
// used only if a driver row has null home coords, so routing still works.
const DEFAULT_HOME = { lat: 38.885871, lon: -90.130106 }; // Tim / Edgerton base

// ── geometry ─────────────────────────────────────────────────────────────
const EARTH_MI = 3958.7613; // mean Earth radius, miles

export function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.sqrt(a));
}

function pointInRing(lon, lat, ring) {
  // Standard ray-cast. ring: [[lon,lat],...]
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect =
      (yi > lat) !== (yj > lat) &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function stateOf(lon, lat) {
  for (const s of STATES) {
    const [minX, minY, maxX, maxY] = s.b;
    if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
    for (const poly of s.p) {
      if (pointInRing(lon, lat, poly)) return s.c;
    }
  }
  return null;
}

// line: [[lon,lat],...] route geometry. Returns { byState:{ST:miles}, total }.
export function milesByState(line) {
  const byState = {};
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    const [lon1, lat1] = line[i - 1];
    const [lon2, lat2] = line[i];
    const d = haversineMiles(lat1, lon1, lat2, lon2);
    if (!d) continue;
    total += d;
    const st =
      stateOf((lon1 + lon2) / 2, (lat1 + lat2) / 2) ||
      stateOf(lon2, lat2) ||
      stateOf(lon1, lat1) ||
      'XX';
    byState[st] = (byState[st] || 0) + d;
  }
  return { byState, total };
}

// line: [[lon,lat],...] route geometry. Returns miles in TRAVEL ORDER, with
// only CONSECUTIVE same-state steps collapsed — so a route that re-enters a
// state (IL -> IN -> IL) yields three ordered runs, not two summed buckets.
// This is the ordering milesByState() throws away, and is exactly what an
// odometer chain needs (each run becomes one ordered segment).
//   Returns { runs:[{state, miles}, ...], total }.
export function milesByStateOrdered(line) {
  const runs = [];
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    const [lon1, lat1] = line[i - 1];
    const [lon2, lat2] = line[i];
    const d = haversineMiles(lat1, lon1, lat2, lon2);
    if (!d) continue;
    total += d;
    const st =
      stateOf((lon1 + lon2) / 2, (lat1 + lat2) / 2) ||
      stateOf(lon2, lat2) ||
      stateOf(lon1, lat1) ||
      'XX';
    const last = runs[runs.length - 1];
    if (last && last.state === st) last.miles += d;
    else runs.push({ state: st, miles: d });
  }
  return { runs, total };
}

// ── routing ──────────────────────────────────────────────────────────────
// coords: [{lat,lon},...] in run order (2+ points).
// Returns { line:[[lon,lat],...], miles, source:'routed'|'estimated' } | null.
export async function routeTruck(env, coords) {
  if (env.ORS_API_KEY) {
    try {
      const res = await fetch(
        'https://api.openrouteservice.org/v2/directions/driving-hgv/geojson',
        {
          method: 'POST',
          headers: {
            Authorization: env.ORS_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            coordinates: coords.map((c) => [c.lon, c.lat]),
          }),
        }
      );
      if (res.ok) {
        const gj = await res.json();
        const feat = gj && gj.features && gj.features[0];
        const line = feat && feat.geometry && feat.geometry.coordinates;
        const meters =
          feat && feat.properties && feat.properties.summary
            ? feat.properties.summary.distance
            : 0;
        if (line && line.length > 1) {
          return { line, miles: meters / 1609.344, source: 'routed' };
        }
      }
    } catch (_) { /* fall through to OSRM */ }
  }
  try {
    const pathStr = coords.map((c) => c.lon + ',' + c.lat).join(';');
    const res = await fetch(
      'https://router.project-osrm.org/route/v1/driving/' +
        pathStr +
        '?overview=full&geometries=geojson',
      { headers: { 'User-Agent': 'LoadLedgers/1.0 (dbappsystems.com)' } }
    );
    if (!res.ok) return null;
    const j = await res.json();
    const r = j && j.routes && j.routes[0];
    if (!r || !r.geometry || !r.geometry.coordinates) return null;
    return {
      line: r.geometry.coordinates,
      miles: r.distance / 1609.344,
      source: 'estimated',
    };
  } catch (_) {
    return null;
  }
}

const r1 = (n) => Math.round(n * 10) / 10;

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

// Find the currently OPEN or CLOSING round for a driver (most recent).
// Returns the round row or null.
async function getActiveRound(env, T, driver) {
  try {
    return await env.DB.prepare(
      "SELECT * FROM ifta_rounds WHERE tenant_id=? AND driver=? AND status IN ('open','closing') ORDER BY opened_at DESC LIMIT 1"
    ).bind(T, driver).first();
  } catch (_) { return null; }
}

// Resolve the anchor odometer for an estimated chain ("both" + round strategy):
//   1) a driver-entered start_odometer (positive finite) wins;
//   2) else the prior segment odo_end for this driver (fact OR estimate),
//      so consecutive loads chain forward continuously;
//   3) else the active round's depart_odo (opens the round at home);
//   4) else null — caller writes miles only, no chain.
// Returns { anchor:number|null, anchorSource }.
async function resolveAnchor(env, T, driver, loadId, startOdometer, round) {
  const entered = Number(startOdometer);
  if (isFinite(entered) && entered > 0) {
    return { anchor: r1(entered), anchorSource: 'entered' };
  }
  try {
    const row = await env.DB.prepare(
      `SELECT odo_end FROM ifta_segments
        WHERE tenant_id=? AND driver=? AND load_id != ?
              AND odo_end IS NOT NULL AND odo_end > 0
        ORDER BY odo_end DESC LIMIT 1`
    ).bind(T, driver, loadId).first();
    if (row && isFinite(Number(row.odo_end)) && Number(row.odo_end) > 0) {
      return { anchor: r1(Number(row.odo_end)), anchorSource: 'prior-chain' };
    }
  } catch (_) { /* fall through */ }
  if (round && isFinite(Number(round.depart_odo)) && Number(round.depart_odo) > 0) {
    return { anchor: r1(Number(round.depart_odo)), anchorSource: 'round-depart' };
  }
  return { anchor: null, anchorSource: 'none' };
}

// Build an estimated odometer chain from ordered runs + an anchor. Mirrors
// ifta_manual.js buildChain: odo_start of run 0 = anchor; each odo_end =
// odo_start + run miles; next odo_start = prior odo_end; miles = odo_end -
// odo_start; integrity: sum(seg miles) === lastOdo - firstOdo to 0.1.
// leg specifies the leg_type stamped on every segment of this chain.
// Returns { ok, segments, firstOdo, lastOdo, totalMiles } | { ok:false, error }.
export function buildEstimatedChain(anchor, runs, leg) {
  const a = Number(anchor);
  if (!isFinite(a) || a <= 0) return { ok: false, error: 'No valid anchor odometer' };
  const ordered = (runs || []).filter((run) => r1(run.miles) > 0);
  if (!ordered.length) return { ok: false, error: 'No positive-mile runs to chain' };

  const segments = [];
  let prevOdo = r1(a);
  let seq = 1;
  for (const run of ordered) {
    const miles = r1(run.miles);
    const odoEnd = r1(prevOdo + miles);
    segments.push({ seq: seq++, state: run.state, odo_start: prevOdo, odo_end: odoEnd, miles, leg_type: leg || 'loaded' });
    prevOdo = odoEnd;
  }
  const firstOdo = r1(a);
  const lastOdo = r1(prevOdo);
  const totalMiles = r1(lastOdo - firstOdo);
  const sumSeg = r1(segments.reduce((acc, s) => acc + s.miles, 0));
  if (sumSeg !== totalMiles) {
    return { ok: false, error: 'Estimated chain integrity failed: segments ' + sumSeg + ' != delta ' + totalMiles };
  }
  return { ok: true, segments, firstOdo, lastOdo, totalMiles };
}

// ── endpoint: POST /api/loads/:id/route-ifta ─────────────────────────────
// Computes loaded-leg state miles + deadhead miles for a load, and (when an
// anchor is resolvable) an ESTIMATED odometer chain into ifta_segments.
// Idempotent: rewrites this load's ifta_miles + routed-estimate segments.
//
// opts:
//   start_odometer : optional explicit anchor (overrides auto-chain).
//   round_id       : optional; when omitted, the driver's active round is used.
//
// Deadhead odometer (home-anchored):
//   • FIRST load of a round (no prior chain for this driver in the round) gets a
//     home->pickup deadhead chain anchored by round depart_odo, then the loaded
//     chain continues forward from the pickup odometer.
//   • Otherwise the incoming deadhead was already laid by the prior load; this
//     load's loaded chain simply continues from the prior odo_end.
export async function handleRouteIfta(env, T, loadId, opts = {}) {
  const load = await env.DB.prepare(
    'SELECT id, driver, delivery_date, created_at FROM loads WHERE id=? AND tenant_id=?'
  ).bind(loadId, T).first();
  if (!load) return { status: 404, body: { error: 'Load not found' } };

  const { results: stops } = await env.DB.prepare(
    'SELECT * FROM load_stops WHERE tenant_id=? AND load_id=? AND lat IS NOT NULL AND lon IS NOT NULL ORDER BY sequence ASC, created_at ASC'
  ).bind(T, loadId).all();
  if (stops.length < 2) {
    return { status: 422, body: { error: 'Need at least 2 geocoded stops (have ' + stops.length + '). Add stops or run /api/load-stops/' + loadId + '/geocode.' } };
  }

  const driver = (load.driver || '').toUpperCase();
  const entryDate = load.delivery_date || '';

  // Loaded legs: route through every stop in run order.
  const routed = await routeTruck(env, stops.map((s) => ({ lat: s.lat, lon: s.lon })));
  if (!routed) return { status: 502, body: { error: 'Routing failed (ORS and OSRM both unreachable)' } };
  const loaded = milesByState(routed.line);
  const loadedOrdered = milesByStateOrdered(routed.line);

  // Resolve the active round (explicit round_id wins, else the driver's open one).
  let round = null;
  if (opts.round_id) {
    round = await env.DB.prepare(
      "SELECT * FROM ifta_rounds WHERE id=? AND tenant_id=?"
    ).bind(String(opts.round_id), T).first();
  }
  if (!round) round = await getActiveRound(env, T, driver);
  const roundId = round ? round.id : null;

  // Deadhead miles: previous load's final stop -> this load's first stop.
  // (Mile rows keep working exactly as before. The home->pickup ODOMETER chain
  // is handled separately below, only for the first load of a round.)
  let deadhead = null;
  let dhSource = routed.source;
  const prev = await env.DB.prepare(
    `SELECT ls.lat AS lat, ls.lon AS lon
       FROM loads l
       JOIN load_stops ls ON ls.load_id = l.id AND ls.tenant_id = l.tenant_id
      WHERE l.tenant_id=? AND UPPER(l.driver)=UPPER(?) AND l.id != ?
        AND l.created_at < ?
        AND ls.lat IS NOT NULL AND ls.lon IS NOT NULL
      ORDER BY l.created_at DESC, ls.sequence DESC, ls.created_at DESC
      LIMIT 1`
  ).bind(T, load.driver || '', loadId, load.created_at).first();
  if (prev) {
    const dhRouted = await routeTruck(env, [
      { lat: prev.lat, lon: prev.lon },
      { lat: stops[0].lat, lon: stops[0].lon },
    ]);
    if (dhRouted) {
      deadhead = milesByState(dhRouted.line);
      dhSource = dhRouted.source;
    }
  }

  // Idempotent rewrite of this load's MILE rows.
  await env.DB.prepare('DELETE FROM ifta_miles WHERE tenant_id=? AND load_id=?')
    .bind(T, loadId).run();

  const insertRow = async (state, miles, legType, source) => {
    await env.DB.prepare(
      `INSERT INTO ifta_miles
         (id, tenant_id, driver, load_id, entry_date, state, miles, leg_type, source, notes, round_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`
    ).bind(
      crypto.randomUUID(), T, driver, loadId, entryDate,
      state, r1(miles), legType, source,
      state === 'XX' ? 'Unattributed sliver (boundary simplification) — kept so totals reconcile' : '',
      roundId,
    ).run();
  };

  for (const [st, mi] of Object.entries(loaded.byState)) {
    if (r1(mi) > 0) await insertRow(st, mi, 'loaded', routed.source);
  }
  if (deadhead) {
    for (const [st, mi] of Object.entries(deadhead.byState)) {
      if (r1(mi) > 0) await insertRow(st, mi, 'deadhead', dhSource);
    }
  }

  // ── ESTIMATED ODOMETER CHAIN ─────────────────────────────────────────────
  // Fact ALWAYS outranks estimate: if this load already carries a driver-manual
  // chain, do NOT lay an estimate over it. Otherwise rewrite this load's
  // routed-estimate segments only (never touch driver-manual rows).
  let odometerChain = null;
  try {
    const factRow = await env.DB.prepare(
      "SELECT 1 AS x FROM ifta_segments WHERE tenant_id=? AND load_id=? AND source='driver-manual' LIMIT 1"
    ).bind(T, loadId).first();
    const hasFact = !!factRow;

    await env.DB.prepare(
      "DELETE FROM ifta_segments WHERE tenant_id=? AND load_id=? AND source='routed-estimate'"
    ).bind(T, loadId).run();

    if (hasFact) {
      odometerChain = { skipped: 'fact-chain-exists' };
    } else {
      // Is this the FIRST load of the active round? (No prior estimate/fact
      // segment carrying a round_id for this round.) If so, lay the home->pickup
      // deadhead chain first, anchored by the round's depart_odo.
      let anchorForLoaded = null;
      let anchorSource = 'none';
      const homeSegments = [];

      let firstOfRound = false;
      if (round && isFinite(Number(round.depart_odo)) && Number(round.depart_odo) > 0) {
        const priorInRound = await env.DB.prepare(
          "SELECT 1 AS x FROM ifta_segments WHERE tenant_id=? AND driver=? AND round_id=? AND load_id != ? LIMIT 1"
        ).bind(T, driver, round.id, loadId).first();
        firstOfRound = !priorInRound;
      }

      if (firstOfRound) {
        // Route home -> first pickup, split by state, chain from depart_odo.
        const home = round.home_lat != null && round.home_lon != null
          ? { lat: Number(round.home_lat), lon: Number(round.home_lon) }
          : await getHome(env, T, driver);
        const homeRoute = await routeTruck(env, [
          { lat: home.lat, lon: home.lon },
          { lat: stops[0].lat, lon: stops[0].lon },
        ]);
        if (homeRoute) {
          const homeOrdered = milesByStateOrdered(homeRoute.line);
          const homeChain = buildEstimatedChain(round.depart_odo, homeOrdered.runs, 'deadhead');
          if (homeChain.ok) {
            for (const s of homeChain.segments) homeSegments.push(s);
            anchorForLoaded = homeChain.lastOdo; // loaded legs continue from pickup odo
            anchorSource = 'round-depart(home->pickup)';
          }
        }
      }

      // If we didn't establish an anchor from the home leg, resolve normally.
      if (anchorForLoaded == null) {
        const r = await resolveAnchor(env, T, driver, loadId, opts.start_odometer, round);
        anchorForLoaded = r.anchor;
        anchorSource = r.anchorSource;
      }

      if (anchorForLoaded == null) {
        odometerChain = { skipped: 'no-anchor', anchor_source: 'none' };
      } else {
        const loadedChain = buildEstimatedChain(anchorForLoaded, loadedOrdered.runs, 'loaded');
        if (!loadedChain.ok) {
          odometerChain = { skipped: 'chain-failed', reason: loadedChain.error };
        } else {
          // Renumber seq across home(deadhead) + loaded so the chain is ordered.
          const allSegs = [...homeSegments, ...loadedChain.segments].map((s, i) => ({ ...s, seq: i + 1 }));
          for (const s of allSegs) {
            await env.DB.prepare(
              `INSERT INTO ifta_segments
                 (id, tenant_id, driver, load_id, seq, entry_date, state, miles,
                  odo_start, odo_end, leg_type, source, notes, round_id, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,'routed-estimate',?,?,datetime('now'))`
            ).bind(
              crypto.randomUUID(), T, driver, loadId, s.seq, entryDate,
              s.state, s.miles, s.odo_start, s.odo_end, s.leg_type,
              'Estimated odometer at state line (' + routed.source + ') — verify + confirm to make fact',
              roundId,
            ).run();
          }
          odometerChain = {
            anchor_source: anchorSource,
            home_leg: homeSegments.length > 0,
            first_odometer: allSegs[0].odo_start,
            last_odometer: allSegs[allSegs.length - 1].odo_end,
            total_miles: r1(allSegs[allSegs.length - 1].odo_end - allSegs[0].odo_start),
            segments: allSegs,
          };
        }
      }
    }
  } catch (_) {
    odometerChain = { skipped: 'error' };
  }

  return {
    status: 200,
    body: {
      ok: true,
      estimated: true,
      source: routed.source,
      round_id: roundId,
      loaded_miles: r1(loaded.total),
      deadhead_miles: deadhead ? r1(deadhead.total) : 0,
      total_miles: r1(loaded.total + (deadhead ? deadhead.total : 0)),
      odometer_chain: odometerChain,
      by_state: Object.fromEntries(
        Object.entries(
          [
            ...Object.entries(loaded.byState),
            ...(deadhead ? Object.entries(deadhead.byState) : []),
          ].reduce((m, [st, mi]) => m.set(st, (m.get(st) || 0) + mi), new Map())
        ).map(([st, mi]) => [st, r1(mi)])
      ),
    },
  };
}

// ── endpoint: GET /api/ifta/:driver?from=&to= ────────────────────────────
// Ongoing ledger summary: per-state totals (loaded + deadhead split out),
// optional date window on entry_date (pass ISO-ish text matching stored dates).
export async function handleIftaSummary(env, T, driver, url) {
  const from = url.searchParams.get('from') || '';
  const to = url.searchParams.get('to') || '';
  const q = parseInt(url.searchParams.get('q') || '0', 10);
  const year = (url.searchParams.get('year') || '').replace(/[^0-9]/g, '');
  const isQuarter = q >= 1 && q <= 4 && year.length === 4;
  let where = 'tenant_id=? AND driver=?';
  const binds = [T, driver.toUpperCase()];
  if (isQuarter) {
    const mStart = String((q - 1) * 3 + 1).padStart(2, '0');
    const mEnd = String(q * 3).padStart(2, '0');
    where += ' AND substr(entry_date,7,4)=? AND substr(entry_date,1,2)>=? AND substr(entry_date,1,2)<=?';
    binds.push(year, mStart, mEnd);
  }
  if (from) { where += ' AND entry_date >= ?'; binds.push(from); }
  if (to)   { where += ' AND entry_date <= ?'; binds.push(to); }

  const { results } = await env.DB.prepare(
    `SELECT state,
            SUM(miles) AS total_miles,
            SUM(CASE WHEN leg_type='loaded'   THEN miles ELSE 0 END) AS loaded_miles,
            SUM(CASE WHEN leg_type='deadhead' THEN miles ELSE 0 END) AS deadhead_miles,
            MIN(source) AS best_source
       FROM ifta_miles
      WHERE ${where}
      GROUP BY state
      ORDER BY total_miles DESC`
  ).bind(...binds).all();

  const grand = results.reduce((s, r) => s + (r.total_miles || 0), 0);

  // ── FUEL SIDE: estimated gallons per state (IFTA fuel computation) ──────
  // REEFER RULE: rows noted 'Refer fuel' are refrigeration diesel — EXCLUDED
  // from IFTA MPG and tax-paid gallons everywhere below.
  // DATE FORMATS DIFFER BY TABLE:
  //   ifta_miles.entry_date   = MM/DD/YYYY  (parsed above: substr 7,4 / 1,2)
  //   fuel_entries.entry_date = YYYY-MM-DD  (parsed here:  substr 1,4 / 6,2)
  let totalGallons = null;
  if (isQuarter) {
    const mStart = String((q - 1) * 3 + 1).padStart(2, '0');
    const mEnd = String(q * 3).padStart(2, '0');
    const row = await env.DB.prepare(
      `SELECT SUM(gallons) AS g FROM fuel_entries
        WHERE tenant_id=? AND UPPER(driver)=? AND fuel_type='fleet'
          AND notes NOT LIKE 'Refer fuel%'
          AND substr(entry_date,1,4)=? AND substr(entry_date,6,2)>=? AND substr(entry_date,6,2)<=?`
    ).bind(T, driver.toUpperCase(), year, mStart, mEnd).first();
    totalGallons = row && row.g ? row.g : 0;
  } else if (!from && !to) {
    const row = await env.DB.prepare(
      `SELECT SUM(gallons) AS g FROM fuel_entries
        WHERE tenant_id=? AND UPPER(driver)=? AND fuel_type='fleet'
          AND notes NOT LIKE 'Refer fuel%'`
    ).bind(T, driver.toUpperCase()).first();
    totalGallons = row && row.g ? row.g : 0;
  }

  const g2 = (n) => Math.round(n * 1000) / 1000;
  const fleetMpg =
    totalGallons && totalGallons > 0 && grand > 0
      ? g2(grand / totalGallons)
      : null;
  const estGal = (miles) =>
    totalGallons && totalGallons > 0 && grand > 0
      ? g2((miles * totalGallons) / grand)
      : null;

  // ── PURCHASED gallons by state (fact side) ──────────────────────────────
  let purchasedByState = null;
  if (isQuarter || (!from && !to)) {
    let fWhere = "tenant_id=? AND UPPER(driver)=? AND fuel_type='fleet' AND notes NOT LIKE 'Refer fuel%'";
    const fBinds = [T, driver.toUpperCase()];
    if (isQuarter) {
      const mS = String((q - 1) * 3 + 1).padStart(2, '0');
      const mE = String(q * 3).padStart(2, '0');
      fWhere += ' AND substr(entry_date,1,4)=? AND substr(entry_date,6,2)>=? AND substr(entry_date,6,2)<=?';
      fBinds.push(year, mS, mE);
    }
    const { results: fuelRows } = await env.DB.prepare(
      `SELECT gallons, notes FROM fuel_entries WHERE ${fWhere}`
    ).bind(...fBinds).all();
    purchasedByState = {};
    for (const fr of fuelRows) {
      const head = String(fr.notes || '').split(' - fuel report')[0];
      const m = head.match(/\b([A-Z]{2})\s*$/);
      const st = m ? m[1] : 'UNKNOWN';
      purchasedByState[st] = g2((purchasedByState[st] || 0) + (fr.gallons || 0));
    }
  }

  // ── IVDR odometer segments (state-line records) ─────────────────────────
  // FACT HIDES ESTIMATE (per-load): a load with ANY driver-manual segment shows
  // ONLY its fact chain — routed-estimate rows for that load are suppressed so
  // the driver never sees a stale estimate beside a verified reading. Loads with
  // no fact chain surface their estimate, tagged source='routed-estimate' and
  // pending=true, so the UI can badge "estimated — verify" and pre-fill the
  // manual IVDR form for one-confirm promotion to fact.
  let segments = [];
  try {
    const { results: segRows } = await env.DB.prepare(
      `SELECT s.load_id, s.seq, s.entry_date, s.state, s.miles,
              s.odo_start, s.odo_end, s.leg_type, s.source, s.round_id, s.notes
         FROM ifta_segments s
        WHERE s.tenant_id=? AND s.driver=?
          AND s.load_id IN (SELECT DISTINCT load_id FROM ifta_miles WHERE ${where})
        ORDER BY s.odo_start ASC`
    ).bind(T, driver.toUpperCase(), ...binds).all();

    const loadsWithFact = new Set(
      segRows.filter((s) => s.source === 'driver-manual').map((s) => s.load_id)
    );
    segments = segRows
      .filter((s) => !(s.source === 'routed-estimate' && loadsWithFact.has(s.load_id)))
      .map((s) => ({
        load_id: s.load_id,
        seq: s.seq,
        date: s.entry_date,
        state: s.state,
        miles: r1(s.miles || 0),
        odo_start: r1(s.odo_start || 0),
        odo_end: r1(s.odo_end || 0),
        leg_type: s.leg_type,
        source: s.source,
        round_id: s.round_id || null,
        pending: s.source === 'routed-estimate',
        notes: s.notes || '',
      }));
  } catch (_) { segments = []; }

  return {
    status: 200,
    body: {
      driver: driver.toUpperCase(),
      estimated: true,
      from, to,
      quarter: isQuarter ? { q, year } : null,
      grand_total_miles: r1(grand),
      total_gallons: totalGallons === null ? null : g2(totalGallons),
      fleet_mpg: fleetMpg,
      gallons_estimated: true,
      purchased_gallons_by_state: purchasedByState,
      segments,
      states: results.map((r) => ({
        state: r.state,
        miles: r1(r.total_miles || 0),
        loaded: r1(r.loaded_miles || 0),
        deadhead: r1(r.deadhead_miles || 0),
        est_gallons: estGal(r.total_miles || 0),
        source: r.best_source,
      })),
    },
  };
}
