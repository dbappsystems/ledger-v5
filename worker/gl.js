// worker/gl.js
// Load Ledger V5 — General Ledger / Chart of Accounts module.
//
// Puzzle-piece design: this module imports nothing from the host worker.
// It is the single source of truth for "which tax account does this row post to."
// Wire-in to worker/index.js is two lines (import + route mount) — see bottom.
//
// Verified facts baked in (Edgerton):
//   * Every driver is a 1099 leased owner-operator -> each files own Schedule C.
//   * Carrier split applies to every driver (Daddyboy Rule), no exemption.
//   * Tim's fuel is ALWAYS Tim's expense. Fleet-card fuel (fuel_entries) and
//     out-of-pocket fuel (maintenance_ledger category='Fuel') BOTH resolve to
//     SCHED_C_09_FUEL on the DRIVER's return. Edgerton never books fuel.
//
// Account codes are the stable contract. Labels/line_refs live in gl_accounts
// so they can be relabeled per-tenant or when IRS line numbers shift, without
// touching source rows.

// ---------------------------------------------------------------------------
// classify(source, row) -> account code (string) or null
// `source` is the table name. `row` is the DB row. Pure function, no I/O.
// Deterministic: given the same row it always returns the same code, so it is
// safe to backfill historical data and safe to hash into an audit chain later.
// ---------------------------------------------------------------------------
export function classify(source, row) {
  switch (source) {
    case 'loads':
      // A load's base_pay is gross receipts on the driver's Schedule C.
      // Accessorials (detention) are also income. The carrier split is handled
      // as its own synthetic posting (see carrierSplitPostings) — not here.
      return 'SCHED_C_01_GROSS';

    case 'expenses': {
      // Per-load expense rows. `type` drives the mapping; `direction` tells us
      // reimbursement vs deduction but not the tax account.
      const t = String(row.type || '').toLowerCase();
      if (t.includes('lumper')) return 'SCHED_C_27_LUMPER';
      if (t.includes('toll') || t.includes('scale')) return 'SCHED_C_24A_TOLLS';
      if (t.includes('comdata') || t.includes('advance')) return 'BS_BROKER_ADVANCE';
      if (t.includes('detention') || t.includes('accessorial')) return 'SCHED_C_ACCESSORIAL';
      return 'SCHED_C_27_OTHER';
    }

    case 'fuel_entries':
      // Fleet-card fuel. Always the driver's fuel expense — the card is only a
      // discount vehicle Edgerton provides. Edgerton does not book this.
      return 'SCHED_C_09_FUEL';

    case 'maintenance_ledger': {
      const c = String(row.category || '').toLowerCase();
      // Out-of-pocket fuel unifies with fleet-card fuel on the driver return.
      if (c === 'fuel') return 'SCHED_C_09_FUEL';
      if (c === 'repair' || c === 'maintenance') return 'SCHED_C_09_MAINT';
      if (c === 'parts' || c === 'equipment') return 'SCHED_C_09_MAINT';
      return 'SCHED_C_27_OTHER';
    }

    case 'carrier_advances':
      // Carrier->driver loan. Balance-sheet receivable, NOT an expense.
      // Repayment reduces the receivable; it never double-counts as a deduction.
      return 'BS_DRIVER_ADVANCE';

    case 'escrow_payments':
      // Money Edgerton holds for the driver. Balance-sheet liability, refundable.
      // Never income to the carrier, never an expense to the driver.
      return 'BS_ESCROW_HELD';

    case 'recurring_charges': {
      const ct = String(row.charge_type || row.label || '').toLowerCase();
      if (ct.includes('insurance')) return 'SCHED_C_15_INSURANCE';
      if (ct.includes('escrow')) return 'BS_ESCROW_HELD';
      if (ct.includes('lease') || ct.includes('rent')) return 'SCHED_C_20A_LEASE_EQUIP';
      if (ct.includes('permit') || ct.includes('ifta') || ct.includes('irp') || ct.includes('license'))
        return 'SCHED_C_23_TAXLIC';
      if (ct.includes('interest')) return 'SCHED_C_16B_INTEREST';
      if (ct.includes('eld') || ct.includes('supply') || ct.includes('supplies'))
        return 'SCHED_C_22_SUPPLIES';
      return 'SCHED_C_27_OTHER';
    }

    case 'asset_payments':
      // Truck/trailer payments feed depreciation basis, not a straight expense.
      return 'SCHED_C_13_DEPREC';

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// carrierSplitPostings(load, splitPct) -> two synthetic postings
// The carrier split is one economic event with two tax faces:
//   - income to Edgerton (CARRIER_COMMISSION_INC)
//   - a commissions/fees expense on the driver's Schedule C (SCHED_C_10_COMMISSION)
// This mirrors real trucking books and keeps the Daddyboy Rule explicit.
// It does NOT change settlement math — it only labels the split for tax roll-up.
// ---------------------------------------------------------------------------
export function carrierSplitPostings(load, splitPct) {
  const base = Number(load.base_pay || 0);
  const split = +(base * (Number(splitPct) / 100)).toFixed(2);
  return [
    { owner: 'CARRIER', driver: null,        code: 'CARRIER_COMMISSION_INC', amount: split, load_id: load.id },
    { owner: 'DRIVER',  driver: load.driver, code: 'SCHED_C_10_COMMISSION',  amount: split, load_id: load.id },
  ];
}

// ---------------------------------------------------------------------------
// Year-end roll-up. Reads classified rows across all source tables for one
// tenant + period and groups them by account, applying deductible_pct.
// Returns a report object ready to render or CSV out. Read-only.
//
// db: the D1 binding (env.DB). tenantId, driver (optional), from/to ISO dates.
// ---------------------------------------------------------------------------
export async function buildScheduleC(db, tenantId, { driver = null, from, to } = {}) {
  // Pull the account master once.
  const accts = await db
    .prepare(
      `SELECT code, schedule, line_ref, label, side, owner_scope, deductible_pct
         FROM gl_accounts
        WHERE tenant_id IN ('_standard', ?1) AND active = 1`
    )
    .bind(tenantId)
    .all();
  const acctMap = new Map((accts.results || []).map((a) => [a.code, a]));

  // Each source table contributes (code, amount, driver). We classify at read
  // time from the stored tax_account_code, falling back to live classify() so a
  // not-yet-backfilled row still lands correctly.
  const buckets = new Map(); // code -> { amount, count }

  const add = (code, amount) => {
    if (!code) return;
    const acct = acctMap.get(code);
    const pct = acct ? Number(acct.deductible_pct) : 100;
    const eff = +(Number(amount) * (pct / 100)).toFixed(2);
    const b = buckets.get(code) || { amount: 0, count: 0 };
    b.amount = +(b.amount + eff).toFixed(2);
    b.count += 1;
    buckets.set(code, b);
  };

  const driverClause = driver ? ' AND driver = ?4' : '';
  const bind = (stmt) =>
    driver ? stmt.bind(tenantId, from, to, driver) : stmt.bind(tenantId, from, to);

  // fuel_entries (fleet-card fuel) — driver fuel
  {
    const q = await bind(
      db.prepare(
        `SELECT amount, driver, tax_account_code, 'fuel_entries' src
           FROM fuel_entries
          WHERE tenant_id = ?1 AND entry_date BETWEEN ?2 AND ?3${driverClause}`
      )
    ).all();
    for (const r of q.results || []) add(r.tax_account_code || classify('fuel_entries', r), r.amount);
  }
  // maintenance_ledger — out-of-pocket fuel + repairs/parts
  {
    const q = await bind(
      db.prepare(
        `SELECT amount, driver, category, tax_account_code
           FROM maintenance_ledger
          WHERE tenant_id = ?1 AND entry_date BETWEEN ?2 AND ?3${driverClause}`
      )
    ).all();
    for (const r of q.results || []) add(r.tax_account_code || classify('maintenance_ledger', r), r.amount);
  }
  // recurring_charges
  {
    const q = await bind(
      db.prepare(
        `SELECT amount, driver, charge_type, label, tax_account_code
           FROM recurring_charges
          WHERE tenant_id = ?1 AND active = 1
            AND (start_date IS NULL OR start_date <= ?3)
            AND (end_date IS NULL OR end_date >= ?2)${driverClause}`
      )
    ).all();
    for (const r of q.results || []) add(r.tax_account_code || classify('recurring_charges', r), r.amount);
  }
  // loads — gross receipts + carrier split expense on driver side
  {
    const splitRow = await db
      .prepare(`SELECT driver_split_pct FROM tenants WHERE id = ?1`)
      .bind(tenantId)
      .first();
    const splitPct = splitRow ? Number(splitRow.driver_split_pct) : 0;
    const q = await bind(
      db.prepare(
        `SELECT id, base_pay, driver, detention, tax_account_code
           FROM loads
          WHERE tenant_id = ?1 AND delivery_date BETWEEN ?2 AND ?3
            AND status != 'booked'${driverClause}`
      )
    ).all();
    for (const r of q.results || []) {
      add(r.tax_account_code || classify('loads', r), r.base_pay);
      if (Number(r.detention) > 0) add('SCHED_C_ACCESSORIAL', r.detention);
      // driver-side commission expense from the split
      for (const p of carrierSplitPostings(r, splitPct)) {
        if (p.owner === 'DRIVER') add(p.code, p.amount);
      }
    }
  }

  // Assemble the report grouped by schedule line, income vs expense separated.
  const lines = [];
  for (const [code, b] of buckets) {
    const a = acctMap.get(code) || { label: code, schedule: '?', line_ref: '?', side: '?', owner_scope: '?' };
    lines.push({
      code,
      label: a.label,
      schedule: a.schedule,
      line_ref: a.line_ref,
      side: a.side,
      owner_scope: a.owner_scope,
      amount: b.amount,
      entries: b.count,
    });
  }
  lines.sort((x, y) => String(x.line_ref).localeCompare(String(y.line_ref), undefined, { numeric: true }));

  const income = lines.filter((l) => l.side === 'INCOME' && l.owner_scope === 'DRIVER')
    .reduce((s, l) => s + l.amount, 0);
  const expense = lines.filter((l) => l.side === 'EXPENSE' && l.owner_scope === 'DRIVER')
    .reduce((s, l) => s + l.amount, 0);

  return {
    tenant_id: tenantId,
    driver: driver || 'ALL',
    period: { from, to },
    lines,
    totals: {
      gross_income: +income.toFixed(2),
      total_deductions: +expense.toFixed(2),
      net_schedule_c: +(income - expense).toFixed(2),
    },
    generated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Router. Mount at /api/gl/*. Read-only endpoints for now.
//   GET /api/gl/accounts?tenant=ten_edgerton
//   GET /api/gl/schedule-c?tenant=ten_edgerton&driver=TIM&from=2026-01-01&to=2026-12-31
// The host passes (request, env) after auth. This module never bypasses auth;
// the host must have already authenticated + resolved tenant before calling.
// ---------------------------------------------------------------------------
export async function handleGl(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/gl/, '');
  const db = env.DB;
  const tenantId = ctx?.tenantId || url.searchParams.get('tenant');
  if (!tenantId) return json({ error: 'tenant required' }, 400);

  try {
    if (path === '/accounts' && request.method === 'GET') {
      const r = await db
        .prepare(
          `SELECT code, schedule, line_ref, label, side, owner_scope, deductible_pct, active
             FROM gl_accounts
            WHERE tenant_id IN ('_standard', ?1)
            ORDER BY schedule, line_ref`
        )
        .bind(tenantId)
        .all();
      return json({ accounts: r.results || [] });
    }

    if (path === '/schedule-c' && request.method === 'GET') {
      const driver = url.searchParams.get('driver');
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!from || !to) return json({ error: 'from and to required' }, 400);
      const report = await buildScheduleC(db, tenantId, {
        driver: driver && driver !== 'ALL' ? driver : null,
        from,
        to,
      });
      return json(report);
    }

    return json({ error: 'not found' }, 404);
  } catch (e) {
    // Generic message to the client; detail stays server-side.
    return json({ error: 'gl request failed' }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// --- Wire-in for worker/index.js (two lines, targeted edit) --------------
//   import { handleGl } from './gl.js';
//   if (url.pathname.startsWith('/api/gl/')) return handleGl(request, env, { tenantId });
