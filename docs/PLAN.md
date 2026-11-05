# Approved plan

This is the plan agreed before any code was written. Update it when a decision changes.

## Decisions

| Area            | Decision                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo            | Standalone repo; npm workspaces: `shared/`, `server/`, `web/`, `e2e/` (Phase 6)                                                                                             |
| Runtime         | Node 24 LTS, TypeScript strict, zod                                                                                                                                         |
| Frontend        | React, Vite, Tailwind CSS, React Router, TanStack Query                                                                                                                     |
| Database        | Neon Postgres via `pg`: pooled URL at runtime, direct URL for migrations. UUID keys, `timestamptz`/`date`, `CHECK` constraints, `ON DELETE CASCADE`. Real Postgres in tests |
| Auth            | Google sign-in (OIDC + PKCE, `openid-client` or `jose`), open signup, `identities(provider, subject, user_id)` table. Cookie sessions (`__Host-`, hashed token in DB)       |
| Demo            | Shared demo account, reset daily; cap about 30 applications; banner; export and deletion disabled                                                                           |
| Hosting         | Vercel (static web + Fastify function), Neon free tier, region: Vercel `cle1` (Cleveland) next to Neon AWS us-east-2 (Ohio), free `*.vercel.app` domain                     |
| Follow-up clock | `last_activity_at` (real user edits only). `updated_at` is audit only                                                                                                       |
| List behaviour  | Closed applications shown, muted. CSV export respects filters. Pipeline counts respect search `q` but ignore the status filter                                              |
| History         | `status_history(from_status, to_status, occurred_at, recorded_at, actor)`. No back-dating in the MVP. `date_applied` auto-fills when status first reaches Applied or later  |
| Concurrency     | `version` column, 409 on conflict. Caps (500 applications per user) enforced under a lock                                                                                   |
| Migrations      | Numbered `.sql` files run from a GitHub Actions CD job on the direct URL; expand/contract; non-transactional steps and timeouts supported                                   |
| Test routes     | Allowlisted (`ENABLE_TEST_ROUTES=1` and (`NODE_ENV=test` or preview) and secret header), synthetic users only (`test:` subject), per-user DB-backed test clock              |
| E2E isolation   | One fresh synthetic user per test; no global reset or per-worker databases                                                                                                  |
| Security        | CSRF via `Origin`/`Sec-Fetch-Site` check and JSON-only mutations; `Lax` OAuth state cookie; `job_link` http(s) only                                                         |
| Ops (public)    | Nightly `pg_dump` plus restore drill; PII-redacted logs; scrubbed error tracking; non-DB uptime check; JSON data export; privacy page                                       |

## Domain rules to confirm in Phase 1 (proposed defaults)

- "7+ days" is 7 calendar days in the user's timezone. A next-step date of today or later is "upcoming"; a past date is not.
- Timezone is set at first login and editable in settings, never sent per request.
- Any status to any status. A same-status PATCH writes no history row. Creating writes `null -> initial`.
- PATCH: `null` clears a field; an absent key leaves it unchanged.
- CSV: UTF-8 BOM, UTC ISO-8601 timestamps, formula-prefix characters (`=`, `+`, `-`, `@`, tab, CR) neutralised.
- "Responded" (stats): ever reached Screening or beyond, or Rejected after Applied.

## Phases

Each phase ends with lint, type-check and all tests green, then stops for review.

| #   | Phase                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------- |
| 0   | Scaffold: workspaces, strict TS, ESLint, Prettier, Vitest, Tailwind, CI, docker compose Postgres                      |
| 0.5 | Deploy spike (throwaway): Fastify on Vercel, Neon pooled query, `__Host-` cookie, migration CD job on the direct URL  |
| 1   | Domain core in `shared/`: constants, schemas, `needsFollowUp`, truth tables, fast-check parity tests                  |
| 2   | DB layer: `pg`, migration runner, schema, `identities`, migration and constraint tests                                |
| 3   | Sessions, CSRF, test-login, per-user clock, demo login, 401s, route-registry meta-test                                |
| 4   | User-scoped CRUD, status history, `version`, locked caps, account deletion, data export, isolation and contract tests |
| 4.5 | Contracts and mutation testing: route response schemas, OpenAPI, fast-check API fuzzing, StrykerJS                    |
| 5a  | Query API: filters, search, sort                                                                                      |
| 5b  | Pipeline counts and CSV export                                                                                        |
| 6   | Web shell, list page, E2E infrastructure with synthetic users, axe, CI e2e job                                        |
| 7   | Google OIDC: real flow, stub provider, negative cases, one redirect E2E                                               |
| 8   | Pipeline bar                                                                                                          |
| 9   | Add, edit, delete                                                                                                     |
| 10  | Detail page and status history                                                                                        |
| 11  | Search, follow-up filter and export UI                                                                                |
| 12  | Hardening: docs, privacy page, security headers, flake check, OWASP ZAP baseline scan                                 |
| 13  | Production deploy: migrate job, backups, uptime check, smoke test, CD                                                 |

## Later phases (not built)

- **Gmail import:** personal-use unless Google verification is obtained (restricted scope). A per-user inbound forwarding address is the cheaper public alternative.
- **Follow-up reminders:** hourly timezone-bucketed job, unique `(user_id, local_date)`, opt-in email.
- **Stats by source:** computed on read (bounded per user by the cap).

## Deferred, with revisit triggers

Search indexes (trigram or full-text), Redis or caching, precomputed stats, queue infrastructure, read replicas, partitioning, multi-region, status page. Revisit when measured latency or cost demands it.

## Phase 0.5 outcome

Passed on 2026-11-05; details and lessons in [SPIKE.md](SPIKE.md). Plan changes that came out of it:

- Function is bundled with esbuild and exposed through a committed `api/index.ts` stub (see SPIKE.md).
- `engines.node` is pinned to `24.x`.
- Postgres is 18 everywhere (Neon, CI, docker compose).
- Assert response bodies in smoke tests, never only status codes.
- Phase 2 sets the `pg` SSL mode explicitly and replaces the spike migration runner and routes.

## Phase 1 outcome

Domain core is in `shared/` (pure, no I/O) with 143 tests including fast-check property tests: constants,
calendar/time-zone date helpers, `needsFollowUp` and `followUpWindow`, status and `dateApplied` rules,
`changedFields`, and zod schemas. Rules are written down in [DOMAIN.md](DOMAIN.md).

## Phase 2 outcome

`server/src/db/`: `createDb` (small pool, explicit TLS, `date` as strings, transactions), the migration runner
(numbered files, checksums, lock/statement timeouts, no-transaction escape hatch, advisory lock), and
`0001_init.sql` (users, identities, sessions, applications, status_history). `server/src/repo/followUpSql.ts` is the
SQL twin of `needsFollowUp`, proven equal by a real-Postgres parity test. Tests run in isolated schemas and CI fails
if the test database is missing. The app takes injected dependencies (`buildApp({ db, logger })`), has a DB-backed
`/api/health/db`, and returns a fixed body for any 5xx. Not done here: rate-limit and test-clock tables (Phase 3,
as additive migrations), applying migrations to Neon (Phase 13).

## Phase 3 outcome

Sessions (`__Host-` cookie, hashed tokens, hourly sliding renewal), the request pipeline (route policy, CSRF guard,
session resolution, `no-store`), demo sign-in and sign-out, `GET/PATCH /api/me`, a database-backed rate limiter,
the allowlisted test-only routes with per-user clocks, migration `0002`, and the route-registry meta-test. Details and
the security reasoning are in [AUTH.md](AUTH.md). Differences from the plan: the profile endpoint is `/api/me`
(not `/api/auth/me`); the isolation matrix is a coverage check that fails until Phase 4's id routes are claimed.

## Phase 4 outcome

`POST /api/applications`, `GET/PATCH/DELETE /api/applications/:id`, `GET /api/me/export`, `DELETE /api/me`, with
strict response contracts, optimistic concurrency, quotas under a lock, per-user write limits, and isolation tests
for every id route. Reference: [API.md](API.md). Differences from the plan: a stale version answers **412** (with
`If-Match`, standard HTTP) rather than 409, and a missing `If-Match` answers 428. Migration `0003` adds a sequence so
history written at the same instant keeps its order. Neon now has migrations 0001 to 0003.

## Portfolio tooling (added after Phase 4)

Chosen by the owner. Consumer-driven contract testing (Pact) was considered and left out: the web app is the only
consumer, lives in the same repo, shares the zod schemas and deploys atomically with the API, so Pact would only
re-verify what the compiler and the schema tests already guarantee. The real skew risk (a browser tab running old
JavaScript across a deploy) is left to backward-compatible API changes and review of the committed OpenAPI spec.

**Phase 4.5: contracts and mutation testing** (JavaScript/Node tools only: Schemathesis (Python) was replaced by fast-check fuzzing, and oasdiff (Go) was dropped) (before 5a, so the list endpoint is covered from day one)

- Every route declares its response schemas in its route config, next to `auth`; a shared `ErrorSchema` covers
  error bodies. In tests, every JSON response is validated against the declared schema, and the route-registry
  meta-test fails for any route without one, so contract coverage is automatic, like the security checks.
- An OpenAPI document is generated from those schemas (committed, and served in non-production builds).
- **API fuzzing with fast-check** (Vitest): for every route, generate valid and hostile inputs from the declared
  schemas, send them through the real app, and assert there is never a 500 and every response matches its
  declared contract. New routes are fuzzed automatically.
- **StrykerJS** runs mutation testing on `shared/` and the server's domain and repository code, with a score
  threshold in CI (incremental, so it stays fast).

**Phase 12 addition:** an **OWASP ZAP** baseline scan in CI against a preview deployment. This is the one
non-JavaScript tool, kept by the owner's choice; it runs only in GitHub Actions through ZAP's official action, with
nothing to install locally.

Not adopted (for now): MSW, Playwright visual comparisons, k6, Lighthouse CI, scheduled production smoke tests.
