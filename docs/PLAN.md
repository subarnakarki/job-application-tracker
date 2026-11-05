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
| Hosting         | Vercel (static web + Fastify function), Neon free tier, region US East for both, free `*.vercel.app` domain                                                                 |
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
| 5a  | Query API: filters, search, sort                                                                                      |
| 5b  | Pipeline counts and CSV export                                                                                        |
| 6   | Web shell, list page, E2E infrastructure with synthetic users, axe, CI e2e job                                        |
| 7   | Google OIDC: real flow, stub provider, negative cases, one redirect E2E                                               |
| 8   | Pipeline bar                                                                                                          |
| 9   | Add, edit, delete                                                                                                     |
| 10  | Detail page and status history                                                                                        |
| 11  | Search, follow-up filter and export UI                                                                                |
| 12  | Hardening: docs, privacy page, security headers, flake check                                                          |
| 13  | Production deploy: migrate job, backups, uptime check, smoke test, CD                                                 |

## Later phases (not built)

- **Gmail import:** personal-use unless Google verification is obtained (restricted scope). A per-user inbound forwarding address is the cheaper public alternative.
- **Follow-up reminders:** hourly timezone-bucketed job, unique `(user_id, local_date)`, opt-in email.
- **Stats by source:** computed on read (bounded per user by the cap).

## Deferred, with revisit triggers

Search indexes (trigram or full-text), Redis or caching, precomputed stats, queue infrastructure, read replicas, partitioning, multi-region, status page. Revisit when measured latency or cost demands it.
