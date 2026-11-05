# Job Application Tracker

Track job applications through a hiring pipeline: pipeline counts per stage, status history,
a "needs follow-up" flag, search and CSV export.

**Status:** Phase 0 (scaffold). See [docs/PLAN.md](docs/PLAN.md) for the approved plan and phases.

## Requirements

- Node 24 LTS (see `.nvmrc`; Node 22.12+ also works locally)
- Docker (for local Postgres, from Phase 2)

## Getting started

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

Run the apps in two terminals:

```sh
npm run dev:server   # http://127.0.0.1:3000/api/health
npm run dev:web      # http://localhost:5173 (proxies /api to the server)
```

## Layout

| Folder    | Purpose                                               |
| --------- | ----------------------------------------------------- |
| `shared/` | zod schemas, constants and pure domain logic (no I/O) |
| `server/` | Fastify API                                           |
| `web/`    | React + Vite + Tailwind frontend                      |
| `e2e/`    | Playwright tests (added in Phase 6)                   |
| `docs/`   | Plan and decisions                                    |
