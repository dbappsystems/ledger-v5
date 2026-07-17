# AGENTS.md

Read `CLAUDE.md` and `docs/AI-MAP.md` first — they are the authoritative operating brief and fast-lookup map for this repo. This file only adds environment/run notes for automated agents.

## Cursor Cloud specific instructions

This is a Cloudflare app: a **React + Vite SPA** (`src/`, served by Cloudflare Pages) and a **Cloudflare Worker API** (`worker/`, backed by D1 + R2 + KV). Production is the source of truth (`main` auto-deploys to Cloudflare Pages). There is real money in the live DB — never point local work at production data.

### Update script
`npm install` (already run before each session). It installs only the frontend/Vite + test toolchain. `wrangler` is not a dependency; use `npx wrangler` when you need it.

### Services, and how to run / test / build them

| Service | Run (dev) | Notes |
|---|---|---|
| Frontend SPA (`src/`) | `npm run dev` (Vite) | Build with `npm run build`. See `package.json` scripts. |
| Worker API (`worker/`) | `npx wrangler dev --local` (from `worker/`) | Needs a seeded local D1 — see caveat below. |
| Tests | `node tests/settlement.golden.test.js` and `node tests/test_tenant_isolation_static.mjs worker/index.js` | Both are self-contained (no DB/network). |

- **Lint:** there is no lint tooling configured (no ESLint config, no `lint` script). "Lint" here means JS/JSX must parse (`node --check` for worker JS; the Vite build fails on bad JSX).
- **CI gate:** `.github/workflows/tenant-wall.yml` runs the static tenant-wall test on push/PR. Keep it green.
- **Golden test** (`tests/settlement.golden.test.js`) is the settlement-math law; never edit the fixture to force a pass (see `CLAUDE.md` §2.9).

### Non-obvious caveats

- **The frontend defaults to the PRODUCTION worker.** `src/api.js` uses `VITE_API_URL || 'https://ledger-v5.d49rwgmpj9.workers.dev'`. Running `npm run dev` with no env talks to production, and login requires real production credentials. For safe local development, run the worker locally and set `VITE_API_URL` to it.
- **CORS is locked** to `https://loadledgers.com` + `*.pages.dev` (`worker/index.js`). A cross-origin browser call from `localhost` is blocked. To exercise the UI against a local worker, use a **same-origin Vite dev proxy** (proxy `/api` → the local worker) and set `VITE_API_URL` to the Vite origin, then browse that exact same host (don't mix `localhost` and `127.0.0.1` — they are different origins).
- **The repo ships only incremental migrations (`migrations/0001+`), not the base V4 schema.** A fresh local D1 (`npx wrangler dev --local`) therefore has no `loads`/`users`/etc. tables. To run the worker locally you must first create the base tables + seed a tenant/user (a plaintext-password user with `salt` NULL works: the login path verifies plaintext then upgrades to PBKDF2). Because of this, local worker dev is not first-class; the frontend + node tests are the primary local workflow.
- **PBKDF2 is hard-capped at exactly 100,000 iterations** by the Workers runtime (`PBKDF2_ITERATIONS`, `CLAUDE.md` §4). Node accepts higher; the deployed/`wrangler dev` Worker does not. Test crypto against `wrangler dev`, never Node alone.
- **Do not run the live isolation test** (`tests/test_tenant_isolation_live.mjs`) or any command that mutates production D1/R2.
