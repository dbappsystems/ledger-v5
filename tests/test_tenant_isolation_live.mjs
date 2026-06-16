// test_tenant_isolation_live.mjs
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — LIVE end-to-end tenant-wall test.
//
// RUN THIS after the v5 worker is deployed AND migration 0001 is applied,
// with two seeded users in two different tenants.
//
//   WORKER_URL=https://your-v5-worker.workers.dev \
//   A_EMAIL=ownerA@example.com  A_PASS=...  \
//   B_EMAIL=ownerB@example.com  B_PASS=...  \
//   node tests/test_tenant_isolation_live.mjs
//
// WHAT IT PROVES (the real thing):
//   Logs in as Tenant A, captures A's data. Logs in as Tenant B. Then uses
//   B's token to call every read endpoint and asserts B NEVER sees A's rows.
//   Also asserts an unauthenticated call is rejected.

const BASE = process.env.WORKER_URL;
const A = { email: process.env.A_EMAIL, pass: process.env.A_PASS };
const B = { email: process.env.B_EMAIL, pass: process.env.B_PASS };

if (!BASE || !A.email || !A.pass || !B.email || !B.pass) {
  console.error('Missing env: WORKER_URL, A_EMAIL, A_PASS, B_EMAIL, B_PASS');
  process.exit(2);
}

let failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

async function login(email, password) {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  if (!j.token) throw new Error('Login failed for ' + email + ': ' + JSON.stringify(j));
  return { token: j.token, tenant_id: j.tenant_id, driver_name: j.driver_name };
}

async function get(path, token) {
  const r = await fetch(BASE + path, {
    headers: token ? { 'Authorization': 'Bearer ' + token } : {},
  });
  return { status: r.status, body: await r.text() };
}

const run = async () => {
  // 0) Unauthenticated read must be rejected.
  const noAuth = await get('/api/loads', null);
  check(noAuth.status === 401, `Unauthenticated /api/loads should be 401, got ${noAuth.status}`);

  // 1) Log in as both tenants.
  const a = await login(A.email, A.pass);
  const b = await login(B.email, B.pass);
  check(a.tenant_id && b.tenant_id && a.tenant_id !== b.tenant_id,
    'A and B must be in different tenants for this test to mean anything.');

  // 2) Pull A's loads (as A) and B's loads (as B).
  const aLoads = JSON.parse((await get('/api/loads', a.token)).body || '[]');
  const bLoads = JSON.parse((await get('/api/loads', b.token)).body || '[]');

  // 3) THE WALL: none of A's load ids may appear in B's result, and vice versa.
  const aIds = new Set(aLoads.map(l => l.id));
  const bIds = new Set(bLoads.map(l => l.id));
  check(!bLoads.some(l => aIds.has(l.id)), 'LEAK: Tenant B can see Tenant A loads.');
  check(!aLoads.some(l => bIds.has(l.id)), 'LEAK: Tenant A can see Tenant B loads.');

  // 4) Every load B receives must carry B's tenant_id (defense in depth).
  const bForeign = bLoads.filter(l => l.tenant_id && l.tenant_id !== b.tenant_id);
  check(bForeign.length === 0, `LEAK: ${bForeign.length} of B's loads carry another tenant_id.`);

  // 5) Brokers endpoint — same wall.
  const aBrokers = JSON.parse((await get('/api/brokers', a.token)).body || '[]');
  const bBrokers = JSON.parse((await get('/api/brokers', b.token)).body || '[]');
  const aBrokerIds = new Set(aBrokers.map(x => x.id));
  check(!bBrokers.some(x => aBrokerIds.has(x.id)), 'LEAK: Tenant B can see Tenant A brokers.');

  console.log('\nLIVE tenant-wall test');
  if (failures.length === 0) {
    console.log('PASS  B never saw A across loads/brokers; unauth rejected.');
    process.exit(0);
  } else {
    console.log(`FAIL  ${failures.length} problem(s):`);
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
};

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
