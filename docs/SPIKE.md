# Phase 0.5: deploy spike checklist

Goal: prove, on the real platforms, the assumptions the later phases depend on. All spike code
lives in `server/src/spike/`, `api/index.ts`, `vercel.json` and `.github/workflows/spike-migrate.yml`
and is deleted when the spike ends.

| Assumption                                              | How it is proven                                   |
| ------------------------------------------------------- | -------------------------------------------------- |
| Fastify runs as a Vercel function, `/api/*` rewrites ok | `GET /api/health`, `GET /api/spike/info`           |
| `@jat/shared` (TS source) resolves in the function      | `/api/spike/info` returns the app name             |
| Function runs in `cle1`, Node 24                        | `/api/spike/info` -> `vercelRegion`, `nodeVersion` |
| Neon pooled URL works with `pg` and a small pool        | `GET /api/spike/db`                                |
| Transactions work through the pooler                    | `POST /api/spike/db/ping`                          |
| Cold start vs warm latency incl. Neon wake-up           | `coldStart` and `queryMs` fields                   |
| `__Host-` cookie is set and returned on the real domain | `/api/spike/cookie/set` then `/cookie/read`        |
| Migrations run from CI on the DIRECT url                | "Spike migrate" workflow                           |

## Steps (you do these; never paste connection strings into chat or commit them)

1. **GitHub: create `main`.** Branches -> New branch `main` from `ccr-07668335-qclamt`, then
   Settings -> Branches -> set `main` as the default branch. (Vercel's production branch and the
   Actions "Run workflow" button both need a default branch.)
2. **GitHub secret.** Settings -> Secrets and variables -> Actions -> New repository secret:
   `DATABASE_URL_DIRECT` = Neon **direct** connection string (pooling toggle off).
3. **Run the migration.** Actions -> "Spike migrate" -> Run workflow (branch `main`). It should log
   `Applied: 001_spike_ping.sql`. Run it again: `Nothing to apply`.
4. **Vercel project.** Add New -> Project -> import this repo. Name: `job-application-tracker`.
   Framework Preset: Other. Leave build settings alone (they come from `vercel.json`).
   Environment variable `DATABASE_URL` = Neon **pooled** string (host contains `-pooler`),
   for Production and Preview. Deploy.
5. **Vercel settings check.** Settings -> General: Node.js Version `24.x`.
   Settings -> Functions: region is Cleveland (`cle1`, next to Neon AWS us-east-2 in Ohio).
6. Tell Claude the production URL. Claude runs the checks above with `curl`.

## What "pass" looks like

- `/api/health` -> `{"status":"ok"}`; `/api/spike/info` -> region `cle1`, Node `v24.*`, app name present.
- `/api/spike/db` first call `coldStart: true`, second `coldStart: false`; record both `queryMs`.
- `/api/spike/db/ping` total increases on each call.
- Cookie: `Set-Cookie` has `__Host-spike=1; Path=/; Secure; HttpOnly; SameSite=Lax`, and
  `/cookie/read` returns `{"present":true}` when the jar is sent back.

## If something fails

Record the exact error here before changing approach. Known fallbacks: bundle the function with
esbuild instead of relying on Vercel's TS handling; use relative imports instead of `@jat/shared`
inside the function; switch driver only if the pooler rejects transactions.

## Status log

### 2026-11-05

Done and verified:

- CI is green on `main` (lint, typecheck, unit with a Postgres service container).
- "Spike migrate" workflow ran against Neon (direct URL): `Applied: 001_spike_ping.sql`.
- Neon project is in **AWS us-east-2 (Ohio)**; `vercel.json` pins functions to `cle1` (Cleveland).
  Whether `cle1` is accepted on the Hobby plan is **not yet confirmed**.
- Vercel project deployed from `main` at https://job-application-tracker-eta-one.vercel.app

Observed on the deployed site:

- `GET /` returns 200 `text/html` (static build and SPA rewrite work).
- Every `/api/*` route, including `/api/health` (which never touches the database), returns
  `500 FUNCTION_INVOCATION_FAILED`. So the function crashes when it loads. It is not a Neon,
  pooler or `DATABASE_URL` problem.

Not yet known: the actual runtime error (Vercel logs were not reachable from the first session).

Leading hypothesis (unconfirmed): Vercel loads `api/index.ts` as ESM without bundling, so either the
extensionless relative imports (`../server/src/app`) fail, or `@jat/shared` (which exports `.ts`
source) cannot be loaded from `node_modules`. Fallback if confirmed: bundle the function with
esbuild into one self-contained file, build it in `buildCommand`, and test the bundle locally.

Next steps:

1. Read the deployment events and, if available, the runtime logs for the latest `main` deployment
   (Vercel connector, or the Logs tab in the dashboard).
2. Fix the cause, verify locally, push, redeploy.
3. Re-run the checks in the table above against the deployed URL, including `POST /api/spike/db/ping`
   and the cookie round trip (use a curl cookie jar), and record cold vs warm `queryMs`.
4. Confirm the function region and Node 24 from `/api/spike/info`.
5. Delete the spike code and write up the outcome in `docs/PLAN.md`; then Phase 1.

Environment notes: the cloud session's network policy must allow
`job-application-tracker-eta-one.vercel.app` (Settings of the cloud environment, Network access),
or `curl` returns `403 CONNECT tunnel failed`.
