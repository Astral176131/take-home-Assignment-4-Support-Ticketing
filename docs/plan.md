# Plan

## How I broke the work into sessions

The build prompt defines 6 phases. I'm treating each phase as roughly one session (1.5–2.5 hours each), with Phase 1 being the largest since it's pure foundation work.

| Phase | Focus | Estimated | Actual |
|-------|-------|-----------|--------|
| 1 | Auth + schema + skeleton | 2.5h | In progress |
| 2 | Core ticket lifecycle (CRUD, replies, state machine) | 2.5h | Not started |
| 3 | Collaboration + authorization hardening | 1.5h | Not started |
| 4 | Queue, search, bulk actions, export | 2h | Not started |
| 5 | Dashboard + SLA alerts | 2h | Not started |
| 6 | Seed data, deploy, docs, polish | 1.5h | Not started |

## What order I built in, and why

### Phase 1 order:
1. **Project scaffolding first** — can't do anything without the monorepo structure, package.json, and configs.
2. **Prisma schema + migration** — the database is the foundation everything depends on. Getting the schema right early means fewer painful migrations later.
3. **Auth endpoints + middleware** — authentication is a prerequisite for every other endpoint. The `requireRole` and `requireTicketAccess` helpers will be reused in every phase.
4. **Tests** — written immediately after the auth code, not deferred. The build prompt explicitly requires this ("write tests as you build each feature, not after").
5. **Frontend shell** — last in Phase 1 because the API needs to work first. Minimal: login page, protected route, layout with logout. No ticket UI yet.
6. **Documentation** — written in the same session while decisions are fresh.

This order follows a "dependencies first" approach: DB → auth → API → tests → UI → docs. Each layer only builds on what's already working.

## What I estimated vs what it actually took

Phase 1 was estimated at 2.5 hours. Key surprise: **Prisma 7** dropped during development and changed the config model — the `datasource.url` moved from `schema.prisma` to a new `prisma.config.ts` file, and the runtime client now requires a driver adapter (`@prisma/adapter-pg`). This wasn't in the build prompt's instructions and added ~15 minutes of debugging and research.

## What I cut when I ran short

Nothing cut in Phase 1 — all planned items were completed. If time pressure builds in later phases, the first things I'd simplify are:
- Frontend polish (functional over beautiful)
- Stretch goals (explicitly optional per the brief)
- CSV export (least impactful of the required features)
