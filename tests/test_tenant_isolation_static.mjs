// test_tenant_isolation_static.mjs
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — STATIC tenant-wall test.
//
// WHAT THIS PROVES
//   Scans worker/index.js and FAILS if any data route can reach the database
//   without the tenant wall. Catches the single catastrophic bug — a query
//   that forgot "tenant_id" — at the source, before deploy, with no DB needed.
//
// HOW
//   1) Confirms requireTenant() exists and runs before any data route.
//   2) Confirms public routes (login/logout/OPTIONS) appear BEFORE the gate,
//      and that the gate (`await requireTenant`) sits above all data routes.
//   3) For every DB statement, asserts it references tenant_id — except the
//      auth-plumbing statements (sessions table + users-by-id/email/upgrade).
//
// RUN:  node tests/test_tenant_isolation_static.mjs worker/index.js
//       (exit 0 = pass, 1 = fail)

import { readFileSync } from 'node:fs';

const FILE = process.argv[2] || 'worker/index.js';
const src = readFileSync(FILE, 'utf8');

let failures = [];
let checks = 0;
const ok   = () => { checks++; };
const fail = (m) => { checks++; failures.push(m); };

// ── 1) The gate exists ──────────────────────────────────────────────────────
if (/async function requireTenant\s*\(/.test(src)) ok();
else fail('requireTenant() is not defined — there is no gate.');

if (/tenant_id:\s*sess\.tenant_id/.test(src)) ok();
else fail('requireTenant() does not derive tenant_id from the session row.');

// ── 2) The gate runs before data routes ─────────────────────────────────────
const gateIdx = src.indexOf('ctx = await requireTenant(env, request)');
const loginIdx = src.indexOf("path === '/api/auth/login'");
const firstDataIdx = src.indexOf("path === '/api/ocr'");
if (gateIdx > -1) ok(); else fail('Gate call "await requireTenant" not found in fetch handler.');
if (loginIdx > -1 && loginIdx < gateIdx) ok();
else fail('Login route is not before the gate (login must be public).');
if (gateIdx > -1 && firstDataIdx > gateIdx) ok();
else fail('A data route appears before the gate — it would run unauthenticated.');

// ── 3) Every DB statement is tenant-scoped ──────────────────────────────────
const stmtRegex = /\.prepare\(\s*(`([\s\S]*?)`|'([^']*)'|"([^"]*)")\s*\)/g;
let m;
while ((m = stmtRegex.exec(src)) !== null) {
  const sql = (m[2] || m[3] || m[4] || '').replace(/\s+/g, ' ').trim();
  const upto = src.slice(0, m.index);
  const lineNo = upto.split('\n').length;

  const upper = sql.toUpperCase();
  const isData = /\b(FROM|INTO|UPDATE)\b/.test(upper);
  if (!isData) continue;

  // Allowed auth-plumbing statements (sessions + user auth lookups).
  const touchesSessions = /\bSESSIONS\b/.test(upper);
  const usersById       = /FROM USERS WHERE ID = \?/.test(upper);
  const usersByEmail    = /FROM USERS WHERE LOWER\(EMAIL\)/.test(upper);
  const usersUpgrade    = /UPDATE USERS SET PASSWORD=\?, SALT=\? WHERE ID=\?/.test(upper);
  const insertSession   = /INSERT INTO SESSIONS/.test(upper);
  if (touchesSessions || usersById || usersByEmail || usersUpgrade || insertSession) continue;

  if (/TENANT_ID/.test(upper)) ok();
  else fail(`Line ${lineNo}: data statement missing tenant_id -> ${sql.slice(0, 90)}`);
}

// ── 4) Spot-check the highest-risk reads explicitly ─────────────────────────
const mustScope = [
  ["loads list",   /SELECT \* FROM loads WHERE tenant_id = \?/],
  ["brokers list", /SELECT \* FROM brokers WHERE tenant_id=\?/],
  ["fuel list",    /FROM fuel_entries WHERE tenant_id=\?/],
  ["assets list",  /FROM assets WHERE tenant_id=\?/],
];
for (const [name, re] of mustScope) {
  if (re.test(src)) ok();
  else fail(`High-risk read "${name}" is not tenant-scoped as expected.`);
}

// ── REPORT ──────────────────────────────────────────────────────────────────
console.log(`\nTenant-wall static test — ${FILE}`);
console.log(`Checks run: ${checks}`);
if (failures.length === 0) {
  console.log('PASS  Every data statement is tenant-scoped; gate runs before data routes.');
  process.exit(0);
} else {
  console.log(`FAIL  ${failures.length} problem(s):`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
