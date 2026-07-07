// worker/ifta-manual.js
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — MANUAL daily state-line odometer chain (driver-entered).
//
// WHAT THIS DOES
//   Tim logs a RAW DAILY chain — a date, a starting odometer, then each
//   state-line crossing reading in travel order. No load attached. Each row
//   is: state + the odometer reading AT the line. Miles are COMPUTED
//   (this reading − the previous reading), never hand-typed, so the chain
//   can never disagree with itself.
//
//   The reading that ENDS one state's miles OPENS the next — the continuous
//   chain Becca Stoller at Carol's Permit Service requires for the IVDR.
//
// WHERE IT WRITES (two mirrored tables, one save)
//   ifta_segments : one row per crossing — date, state, odo_start, odo_end,
//                   miles, seq, leg_type='loaded', source='driver-manual',
//                   load_id='' (daily chain is not load-bound). This is the
//                   IVDR the summary endpoint already reads and returns, so
//                   manual rows appear on the card with zero display changes.
//   ifta_miles    : per-state mile totals for the same day, source=
//                   'driver-manual', load_id=''. This is the quarterly filing
//                   ledger the IFTA card and IVDR CSV already sum — manual
//                   miles fold into the quarter automatically.
//
// INTEGRITY RULES (Accountability Without Exception)
//   1. Odometer ALWAYS increases. Every reading must exceed the one before it,
//      and the whole chain must open at or above the driver's highest recorded
//      odometer — a daily log can never travel backward in time on the truck.
//   2. sum(segment miles) === last reading − start reading, to the tenth.
//   3. sum(per-state ifta_miles) === chain total, to the tenth. No mile is
//      lost or invented between the two tables.
//
// PREVIEW-FIRST
//   Without confirm:true the handler validates the chain and returns the
//   computed rows + totals, writing NOTHING. The client shows the driver what
//   will be saved; a second call with confirm:true commits. This mirrors the
//   fuel-reconcile flow already in the app.
//
// DATE FORMAT — matches the sibling tables exactly:
//   ifta_segments.entry_date / ifta_miles.entry_date = MM/DD/YYYY.
//   The client sends an ISO date (YYYY-MM-DD from the iPhone date picker);
//   this module converts to MM/DD/YYYY on write so the quarterly substr()
//   filter in worker/ifta.js reads manual rows identically to routed rows.

const r1 = (n) => Math.round(n * 10) / 10;

// ISO YYYY-MM-DD -> MM/DD/YYYY (the stored ledger format). Returns '' on a
// shape it does not recognize rather than guessing, so a bad date never
// becomes a mis-filed quarter.
function isoToLedgerDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return m[2] + '/' + m[3] + '/' + m[1];
}

// ── endpoint: POST /api/ifta/manual ──────────────────────────────────────
// Body: {
//   driver, date (YYYY-MM-DD),
//   start_odometer (number),
//   rows: [ { state:'IL', odometer:1027590 }, ... ],   // reading AT each line
//   confirm: true|false
// }
export async function handleIftaManual(env, T, body) {
  const driver = String(body && body.driver || '').toUpperCase().trim();
  if (!driver) return { status: 400, body: { error: 'Driver is required.' } };

  const ledgerDate = isoToLedgerDate(body && body.date);
  if (!ledgerDate) {
    return { status: 400, body: { error: 'Date must be YYYY-MM-DD.' } };
  }

  const start = Number(body && body.start_odometer);
  if (!isFinite(start) || start <= 0) {
    return { status: 400, body: { error: 'Enter the starting odometer.' } };
  }

  const rawRows = Array.isArray(body && body.rows) ? body.rows : [];
  const rows = rawRows
    .map((r) => ({
      state: String(r && r.state || '').toUpperCase().trim(),
      odometer: Number(r && r.odometer),
    }))
    .filter((r) => r.state && isFinite(r.odometer));
  if (rows.length < 1) {
    return { status: 400, body: { error: 'Add at least one state crossing.' } };
  }

  // INTEGRITY RULE 1 — floor against the driver's highest recorded reading.
  // A daily chain can open equal to the last reading (same day continues) but
  // never below it. Checks ifta_segments (routed chain) AND fuel_entries
  // (fuel-up odometer) so the floor reflects every reading on record.
  const segFloor = await env.DB.prepare(
    'SELECT MAX(odo_end) AS m FROM ifta_segments WHERE tenant_id=? AND driver=?'
  ).bind(T, driver).first();
  const fuelFloor = await env.DB.prepare(
    'SELECT MAX(odometer) AS m FROM fuel_entries WHERE tenant_id=? AND UPPER(driver)=?'
  ).bind(T, driver).first();
  const floor = Math.max(
    (segFloor && segFloor.m) || 0,
    (fuelFloor && fuelFloor.m) || 0
  );
  if (floor > 0 && start < floor) {
    return {
      status: 422,
      body: {
        error: 'Starting odometer ' + start + ' is below the last recorded ' +
          'reading ' + r1(floor) + '. The odometer only goes up.',
        floor: r1(floor),
      },
    };
  }

  // INTEGRITY RULE 1 (cont.) — every reading exceeds the one before it, and
  // the first row exceeds the start. Build the computed rows as we validate.
  const computed = [];
  let prev = start;
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i].odometer;
    if (!(cur > prev)) {
      return {
        status: 422,
        body: {
          error: 'Row ' + (i + 1) + ' (' + rows[i].state + '): odometer ' +
            cur + ' must be greater than the previous reading ' + r1(prev) + '.',
        },
      };
    }
    computed.push({
      seq: i + 1,
      state: rows[i].state,
      odo_start: r1(prev),
      odo_end: r1(cur),
      miles: r1(cur - prev),
    });
    prev = cur;
  }

  const chainMiles = r1(prev - start);

  // Per-state fold — INTEGRITY RULE 3. A state crossed twice in one day sums.
  const byState = {};
  for (const c of computed) byState[c.state] = r1((byState[c.state] || 0) + c.miles);

  // PREVIEW — validate only, write nothing.
  if (!(body && body.confirm === true)) {
    return {
      status: 200,
      body: {
        preview: true,
        driver,
        date: ledgerDate,
        start_odometer: r1(start),
        end_odometer: r1(prev),
        chain_miles: chainMiles,
        floor: r1(floor),
        segments: computed,
        by_state: byState,
      },
    };
  }

  // COMMIT — idempotent for this driver+date daily chain: wipe any prior
  // manual rows for the same day, then rewrite. Routed rows (load-bound,
  // source!='driver-manual') are never touched. This lets a driver re-log a
  // day to fix a typo without stacking duplicates.
  await env.DB.prepare(
    "DELETE FROM ifta_segments WHERE tenant_id=? AND driver=? AND source='driver-manual' AND load_id='' AND entry_date=?"
  ).bind(T, driver, ledgerDate).run();
  await env.DB.prepare(
    "DELETE FROM ifta_miles WHERE tenant_id=? AND driver=? AND source='driver-manual' AND load_id='' AND entry_date=?"
  ).bind(T, driver, ledgerDate).run();

  // Write segments (the IVDR crossing rows).
  for (const c of computed) {
    await env.DB.prepare(
      `INSERT INTO ifta_segments
         (id, tenant_id, driver, load_id, seq, entry_date, state, miles,
          odo_start, odo_end, leg_type, source, notes, created_at)
       VALUES (?,?,?,'',?,?,?,?,?,?, 'loaded','driver-manual','Manual daily log', datetime('now'))`
    ).bind(
      crypto.randomUUID(), T, driver, c.seq, ledgerDate, c.state,
      c.miles, c.odo_start, c.odo_end
    ).run();
  }

  // Mirror per-state totals into ifta_miles (the quarterly filing ledger).
  for (const st of Object.keys(byState)) {
    if (byState[st] <= 0) continue;
    await env.DB.prepare(
      `INSERT INTO ifta_miles
         (id, tenant_id, driver, load_id, entry_date, state, miles,
          leg_type, source, notes, created_at, updated_at)
       VALUES (?,?,?,'',?,?,?, 'loaded','driver-manual','Manual daily log', datetime('now'), datetime('now'))`
    ).bind(
      crypto.randomUUID(), T, driver, ledgerDate, st, byState[st]
    ).run();
  }

  return {
    status: 200,
    body: {
      applied: true,
      driver,
      date: ledgerDate,
      start_odometer: r1(start),
      end_odometer: r1(prev),
      chain_miles: chainMiles,
      segments_written: computed.length,
      states_written: Object.keys(byState).length,
      by_state: byState,
    },
  };
}
