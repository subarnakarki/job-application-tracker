# Job Application Tracker

## What this is

A personal app for tracking job applications through a hiring pipeline.
Built by an SDET, so it doubles as a portfolio project: test quality matters
as much as feature quality.

## Stack

- Frontend: React + TypeScript + Vite, Tailwind CSS, TanStack Query, React Router
- Backend: Node 24 LTS + TypeScript (Fastify), zod validation
- Database: Neon Postgres (`pg`, pooled URL at runtime, direct URL for migrations), UUID primary keys
- Auth: Google sign-in (OIDC + PKCE), open signup, cookie sessions, plus a shared demo login
- Hosting: Vercel (static web + Fastify serverless function), region US East, free `*.vercel.app` domain
- Unit/API tests: Vitest. E2E tests: Playwright (Page Object Model, fixtures, role-based locators)
- CI: GitHub Actions (lint, type-check, unit, e2e on every PR)

## Domain

Application fields: company, role, status, date applied, source
(LinkedIn, Indeed, Referral, Company site, Recruiter, Other),
salary range, job link, contact, next step, next step date, notes,
created/updated timestamps, status history.

Statuses: Saved, Applied, Screening, Interviewing, Offer, Rejected, Withdrawn.
"Closed" = Rejected or Withdrawn.
"Needs follow-up" = Applied/Screening/Interviewing with no update in 7+ days
and no upcoming next-step date.

## Conventions

- TypeScript strict mode, no `any`
- Validate API input (zod)
- Every feature ships with tests: unit for logic, API tests for endpoints,
  Playwright for user flows
- Test data via API seeding or fixtures, never through the UI
- Mobile-first, accessible UI (labels, keyboard focus, light/dark mode)
- Small, reviewable commits

## Workflow

- Plan first. Don't write code until the plan is approved. The approved plan is in `docs/PLAN.md`.
- Work in phases. After each phase: run lint, type-check, and all tests before moving on, then stop for review.
- Commit after each small logical step (not only at the end of a phase) and push immediately, so progress is
  always on the remote. Keep every commit green (lint, type-check, tests) and use clear, descriptive messages.
- Work directly on `main` and push to `main` (the owner's standing instruction; plain pushes, never force).
  Vercel production deploys from `main`, so every push redeploys; keep `main` green. Commits are authored by the
  owner with a `Co-Authored-By: Claude` trailer.

## Commands

- `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test` (all from the repo root)
- `npm run dev:server` (Fastify on :3000), `npm run dev:web` (Vite, proxies `/api` to :3000)
- `npm run db:up` starts local Postgres (docker compose); used from Phase 2

## Layout

- `shared/` zod schemas, constants, pure domain logic (no I/O)
- `server/` Fastify app (`buildApp` takes injected dependencies), routes, repo layer (all SQL)
- `web/` React app
- `e2e/` Playwright (added in Phase 6)
