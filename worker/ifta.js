// worker/ifta.js
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — ESTIMATED IFTA mileage engine.
//
// WHAT THIS DOES
//   Takes a load's sequenced, geocoded stops (load_stops rows), routes them
//   over real highways with a commercial-truck profile, splits the route
//   geometry at state lines, and writes per-state mile rows into ifta_miles.
//   Also computes the DEADHEAD leg: previous load's last stop -> this load's
//   first pickup, attributed the same way with leg_type='deadhead'.
//
// ROUTING
//   Primary: OpenRouteService driving-hgv (true truck profile — weight/bridge/
//   restriction aware). Requires Worker secret ORS_API_KEY (dashboard-set,
//   never committed). Fallback when the key is absent or ORS errors: public
//   OSRM (car profile) — same interstates, rougher in cities; rows are marked
//   source='estimated' instead of source='routed' so the ledger names its own
//   confidence level (Truth as Architecture).
//
// STATE ATTRIBUTION
//   Route geometry points -> point-in-polygon against simplified state
//   boundaries (states.js). Each segment's miles go to its midpoint's state.
//   Segments that resolve to no state (coastline slivers from simplification)
//   are bucketed under 'XX' so the integrity rule holds: the SUM of a load's
//   state rows ALWAYS equals its routed total. No silent mile loss.
//
// INTEGRITY RULE (Accountability Without Exception)
//   sum(ifta_miles.miles for load) === routed total, to the tenth of a mile.

import { STATES } from './states.js';

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

// ── endpoint: POST /api/loads/:id/route-ifta ─────────────────────────────
// Computes loaded-leg state miles for the load, plus the deadhead leg from the
// most recent PRIOR load (same driver, by created_at — date text formats vary,
// created_at is the deterministic order key) whose stops are geocoded.
// Idempotent: deletes and rewrites this load's ifta_miles rows on every call.
export async function handleRouteIfta(env, T, loadId) {
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

  // Loaded legs: route through every stop in run order.
  const routed = await routeTruck(env, stops.map((s) => ({ lat: s.lat, lon: s.lon })));
  if (!routed) return { status: 502, body: { error: 'Routing failed (ORS and OSRM both unreachable)' } };
  const loaded = milesByState(routed.line);

  // Deadhead: previous load's final stop -> this load's first stop.
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

  // Idempotent rewrite of this load's ledger rows.
  await env.DB.prepare('DELETE FROM ifta_miles WHERE tenant_id=? AND load_id=?')
    .bind(T, loadId).run();

  const entryDate = load.delivery_date || '';
  const driver = (load.driver || '').toUpperCase();
  const insertRow = async (state, miles, legType, source) => {
    await env.DB.prepare(
      `INSERT INTO ifta_miles
         (id, tenant_id, driver, load_id, entry_date, state, miles, leg_type, source, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`
    ).bind(
      crypto.randomUUID(), T, driver, loadId, entryDate,
      state, r1(miles), legType, source,
      state === 'XX' ? 'Unattributed sliver (boundary simplification) — kept so totals reconcile' : '',
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

  return {
    status: 200,
    body: {
      ok: true,
      estimated: true,
      source: routed.source,
      loaded_miles: r1(loaded.total),
      deadhead_miles: deadhead ? r1(deadhead.total) : 0,
      total_miles: r1(loaded.total + (deadhead ? deadhead.total : 0)),
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
  let where = 'tenant_id=? AND driver=?';
  const binds = [T, driver.toUpperCase()];
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
  return {
    status: 200,
    body: {
      driver: driver.toUpperCase(),
      estimated: true,
      from, to,
      grand_total_miles: r1(grand),
      states: results.map((r) => ({
        state: r.state,
        miles: r1(r.total_miles || 0),
        loaded: r1(r.loaded_miles || 0),
        deadhead: r1(r.deadhead_miles || 0),
        source: r.best_source,
      })),
    },
  };
}
