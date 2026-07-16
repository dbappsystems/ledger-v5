# Load Ledger V5 — D1 → R2 Backup Worker

A standalone, scheduled Cloudflare Worker that writes full SQL dumps of the
production D1 database into a dedicated R2 bucket. This is the **second layer** of
data protection on top of D1 Time Travel.

## Why two layers

| Layer | What it covers | Window | Setup |
|---|---|---|---|
| **D1 Time Travel** (built-in, always on) | bad migration, `DELETE`/`UPDATE` without `WHERE`, point-in-time restore | last **30 days** (Paid) / 7 days (Free) | none |
| **This Worker** (D1 → R2 dumps) | retention beyond 30 days, a copy that lives outside the database | as long as you keep the files (default 90 days) | one-time, below |

The settlement math is reconstructable from the raw tables via
`src/settlementMath.js`, so a restored dump can be **proven correct** by running
`node tests/settlement.golden.test.js`.

## Safety

This Worker **cannot harm the live app**:
- It only **reads** D1 (`SELECT` / `sqlite_master`); it never writes to D1.
- It writes **only** to the backup R2 bucket (`BACKUP_R2`).
- It is a **separate** Worker — it shares no code or routes with `worker/`, so
  deploying it can never break the production API.

## One-time setup

```sh
# 1) Create the backup bucket (once).
npx wrangler r2 bucket create load-ledger-v5-backups

# 2) (Optional) enable the manual trigger / status endpoint from a phone browser.
#    Leave unset to run cron-only (the fetch endpoint stays disabled).
cd backup-worker
npx wrangler secret put BACKUP_TRIGGER_TOKEN   # paste a long random string

# 3) Deploy the Worker (registers the daily cron trigger).
npx wrangler deploy
```

That's it. The cron in `wrangler.toml` (`0 8 * * *` = daily 08:00 UTC) runs the
backup automatically — no phone action needed.

## Manual trigger / status (optional)

Only works if `BACKUP_TRIGGER_TOKEN` is set. Replace `<TOKEN>` and the workers.dev
host with yours.

```sh
# Kick a backup now:
curl -X POST "https://ledger-v5-backup.<subdomain>.workers.dev/run?token=<TOKEN>"

# See the most recent backups:
curl "https://ledger-v5-backup.<subdomain>.workers.dev/status?token=<TOKEN>"
```

Both accept the token as `?token=` (tap-a-link friendly) or an
`Authorization: Bearer <TOKEN>` header.

## Backup layout

```
d1/load-ledger-v5-db/2026/20260716-080000.sql
```

Each object also carries `customMetadata` with `tables`, `rows`, and
`generatedAt`. Dumps older than `RETENTION_DAYS` are pruned on each run.

## Restore

A restore is **destructive** — it overwrites the target database. Prefer restoring
into a **scratch** database first and verifying before touching production.

```sh
# 1) Download a chosen dump from R2.
npx wrangler r2 object get load-ledger-v5-backups/d1/load-ledger-v5-db/2026/20260716-080000.sql --file=restore.sql

# 2) Create a scratch DB and import into it.
npx wrangler d1 create ll-v5-restore-test
npx wrangler d1 execute ll-v5-restore-test --file=restore.sql --remote

# 3) Prove it: run the settlement golden test (self-contained) and spot-check row counts.
node tests/settlement.golden.test.js
npx wrangler d1 execute ll-v5-restore-test --remote --command="SELECT COUNT(*) FROM loads;"
```

For an in-place production point-in-time recovery within 30 days, prefer **D1
Time Travel** instead of a dump:

```sh
npx wrangler d1 time-travel info load-ledger-v5-db
npx wrangler d1 time-travel restore load-ledger-v5-db --timestamp="2026-07-16T08:00:00Z"
```

## Local test

```sh
cd backup-worker
# seed a local D1 with the same DB name, then:
npx wrangler dev --local --test-scheduled
# trigger the cron handler locally:
curl "http://localhost:8787/__scheduled"
# or, with BACKUP_TRIGGER_TOKEN set in .dev.vars:
curl -X POST "http://localhost:8787/run?token=<TOKEN>"
```
