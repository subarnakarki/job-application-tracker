# Job Application Tracker

Track job applications through a hiring pipeline: counts per stage, status history, a "needs follow-up"
flag, search, filters and CSV export. Sign in with Google, or try the shared demo account.

**Live:** https://job-application-tracker-eta-one.vercel.app

Built by an SDET as a portfolio project, so the tests matter as much as the features.

## Features

- Pipeline bar with a count per stage (Saved, Applied, Screening, Interviewing, Offer, Rejected, Withdrawn).
  Tap a stage to filter.
- Search, sort and a "needs follow-up" filter: Applied, Screening or Interviewing with no update for 7+ days and
  no upcoming next step, worked out in your own time zone. Filters live in the URL.
- Board view: drag an application to another stage column (mouse, long-press on touch, or the keyboard), or
  use the "Move to" menu on any card in the list or the board. Moves show at once and roll back if they fail.
- Add, edit and delete, with status history. Edits send only changed fields and are guarded against overwriting
  someone else's change (`If-Match`, 412 on conflict).
- CSV export (respects the filters), JSON download of everything, account deletion.
- Stats by source: applied, responded, interviewed and offers per source, with response rates.
- Gmail import (owner only): reads recent job emails with read-only access, has Claude classify each one, applies
  the clear-cut changes and lists the rest for review, with Undo on every change. A new application is filled in
  from the job posting the email links to, or a likely posting on the company's job board is suggested.
- Job details from the posting: "Fill from link" in the form and "Fill from posting" on an application read a
  public posting (company career sites, Greenhouse, Lever, Ashby, Rippling, Workday and others) and fill only empty fields:
  role, salary, location, work mode and posting date. "Find posting" looks an application without a link up on
  the company's public job board and suggests the match.
- Resume match: upload a resume (PDF, Word or pasted text) and Claude reads it as a senior recruiter would,
  listing the 20 job titles it fits best with the keywords applicant tracking systems match for each, marked found
  or missing in the resume by plain code. "Check my resume" scores the resume against one application's posting.
- Job search (owner only): a one-time setup, then on your schedule it runs your Google-style queries
  (`site:job-boards.greenhouse.io "product manager"`) through Claude's web search, reads each new job from
  Greenhouse, Lever, Ashby or Workday, keeps the past day's postings, sorts target roles from keyword-only
  ones, and drafts every application. The apply queue lists every answer per job for Claude in Chrome (or you)
  to fill in and submit, with go / go all, and Mark applied adds each one to the tracker.
- Mobile-first, keyboard and screen-reader friendly, with a dark design (Inter, self-hosted) and
  respect for reduced-motion settings. Colours are tokens, so a light theme can be added later.

## Stack

| Layer    | Choice                                                                            |
| -------- | --------------------------------------------------------------------------------- |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 4, TanStack Query, React Router, dnd-kit |
| Backend  | Node 24, Fastify 5, zod (schemas shared with the frontend)                        |
| Data     | Neon Postgres (`pg`), plain SQL, numbered migrations with checksums               |
| Auth     | Google OIDC (authorization code + PKCE, `jose`), cookie sessions                  |
| Hosting  | Vercel (static app + one serverless function), US East                            |
| Tests    | Vitest, Testing Library, fast-check, Playwright                                   |
| CI       | GitHub Actions: lint, format, type-check, unit/API, e2e                           |

## How it is tested

About 890 unit and API tests and 25 end-to-end runs (desktop and phone viewports), all on every push.

- **API tests against real Postgres.** Every test gets a fresh, migrated schema; no mocks of the database.
- **Contract checks on every response.** Each route declares its inputs and responses; in tests every response
  is validated against that declaration, and the same declarations generate the
  [OpenAPI document](docs/openapi.json) (a test fails if it is stale).
- **Route-registry meta-test.** Walks every registered route and asserts that public routes match an explicit
  allowlist, every signed-in route rejects bad sessions, every write refuses cross-site requests, nothing is
  cached and no error leaks internals. Routes that take an id must name the test proving another user gets 404.
- **Property-based API fuzzing** (fast-check) of every route from its contract: never a 5xx, never an
  undocumented status. It found real bugs (for example, a NUL character in a search returned 500).
- **Playwright e2e** on desktop and phone viewports with page objects and fixtures. Each test signs in as a fresh
  user through a test-only route and seeds data through the API, never the UI; the follow-up test moves that
  user's clock forward 8 days.
- **Google sign-in** is tested with an injected stub provider and locally signed ID tokens: wrong audience,
  wrong issuer, nonce replay, unverified email, expired or foreign-signed tokens, login CSRF and open redirects.

## Security

- `__Host-` session cookie (Secure, HttpOnly, SameSite=Lax); only a SHA-256 of the token is stored.
- CSRF defence without tokens: `Sec-Fetch-Site`/`Origin` checks and JSON-only bodies.
- Rate limits on sign-in and writes, per-user quotas, strict CSP and security headers.
- Test-only routes exist only when explicitly enabled outside production, behind a secret.

Details: [docs/AUTH.md](docs/AUTH.md). API reference: [docs/API.md](docs/API.md). Domain rules:
[docs/DOMAIN.md](docs/DOMAIN.md). Plan and decisions: [docs/PLAN.md](docs/PLAN.md).

## Running locally

Requirements: Node 24 (`.nvmrc`) and Docker.

```sh
npm ci
npm run db:up                                   # Postgres 18 on :5432 (user/password/db: jat)
DATABASE_URL_DIRECT=postgres://jat:jat@127.0.0.1:5432/jat npm run db:migrate

DATABASE_URL=postgres://jat:jat@127.0.0.1:5432/jat npm run dev:server   # API on :3000
npm run dev:web                                                         # app on http://localhost:5173
```

Locally, sign in with the demo account (Google sign-in needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` and a
registered redirect URI).

Checks:

```sh
npm run lint && npm run format:check && npm run typecheck
TEST_DATABASE_URL=postgres://jat:jat@127.0.0.1:5432/jat npm test

# e2e: a separate, migrated database the tests may write to
npx playwright install chromium   # once
E2E_DATABASE_URL=postgres://jat:jat@127.0.0.1:5432/jat_e2e npm run test:e2e
```

## Layout

| Folder    | Purpose                                                     |
| --------- | ----------------------------------------------------------- |
| `shared/` | zod schemas, constants and pure domain logic (no I/O)       |
| `server/` | Fastify app, routes, auth, SQL repository layer, migrations |
| `web/`    | React app                                                   |
| `e2e/`    | Playwright tests (page objects, fixtures)                   |
| `docs/`   | Plan, API, auth and domain notes, OpenAPI document          |

## Deployment

Vercel builds the app and bundles the API into one function on every push to `main`. Migrations run from the
manual "Migrate" GitHub Actions workflow. Secrets (`DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) live
in Vercel and GitHub, never in the repository.
