# Submission

## Links

- **GitHub:** https://github.com/Astral176131/take-home-Assignment-4-Support-Ticketing
- **Live app:** https://take-home-assignment-4-support-tick.vercel.app
- **API:** https://take-home-assignment-4-support-ticketing-f3wf.onrender.com

The API runs on Render's free tier and sleeps after 15 minutes of inactivity. The first
request after that takes 30–60 seconds — that is the host waking up, not a broken
deployment.

## Demo credentials

| Role | Email | Password |
|------|-------|----------|
| Supervisor | supervisor1@example.com | super123 |
| Agent | agent1@example.com | agent123 |

Additional accounts: `supervisor2@example.com` / `super456`, `agent2@example.com` /
`agent456` through `agent4@example.com` / `agent101`. Signing in as different agents
is the quickest way to verify the authorization rules — an agent sees only their own
tickets, and gets a 403 from any ticket they don't hold.

## What I built

A support ticketing system with a five-state lifecycle (`new → open → pending → resolved
→ closed`), role-based access for agents and supervisors, SLA tracking with breach alerts,
and a dashboard with aggregate analytics.

**Architecture:** React 19 SPA (Vite) against an Express 5 JSON API, backed by Postgres
via Prisma 7. The frontend holds no business rules — every authorization check, state
transition, and SLA computation is enforced server-side. Auth is a JWT in an `httpOnly`
cookie, with the API proxied through the client's origin to keep the cookie first-party
across all browsers.

Full architecture details in `docs/architecture.md`; the database design in
`docs/schema.md`.

## Engineering highlights

**Server-side authorization on every route.** Supervisors see the full queue; agents see
only tickets they hold as assignee or collaborator. `authorization.test.ts` is a
table-driven negative-case test that proves every route refuses the disallowed actor with
the correct status code. During review, this surfaced a fail-open bug: Prisma silently
drops `undefined` filter values, which turned a collaborator lookup into "any
collaborator." The fix is a fail-closed guard — the helper rejects when it doesn't know
who is asking.

**Immutability enforced by a database trigger, not a revoke.** The build prompt suggested
revoking `UPDATE`/`DELETE` grants on `ticket_events`. I checked first: the application's
role *owns* the table, and a Postgres owner's privileges are inherent — `REVOKE` would
have been a silent no-op. A `BEFORE UPDATE OR DELETE` trigger fires regardless of
privilege level. (`docs/decisions.md` 13)

**A pure, table-driven state machine.** Legal transitions are a whitelist; everything else
is rejected with a specific reason and an appropriate status code (400/403/409). The same
function that enforces transitions also computes `allowed_transitions` for the UI, so the
client never holds its own copy of the rules. (`docs/decisions.md` 7)

**Concurrency guards on state changes.** Status updates use conditional writes
(`updateMany` with the expected state in the `WHERE` clause) inside transactions, so a
racing request matches zero rows rather than applying a change the state machine already
ruled out. This matters because `ticket_events` rows are append-only — a duplicate
history entry cannot be cleaned up afterwards.

**Deployment debugging: the iOS cookie problem.** Desktop Chrome accepted the cross-domain
session cookie. iOS Safari discarded it outright — the cookie was third-party. The server
was already correct (`Secure`, `SameSite=None`, credentialed CORS). The fix was to proxy
`/api/*` through the client's own origin so the cookie is first-party. This bug is
invisible to the test suite by construction: Supertest drives Express in-process with no
browser and no cookie jar. (`docs/decisions.md` 15)

**Seed data driven through the real API.** The seed script creates 50 demo tickets by
calling the actual endpoints in-process (via Supertest), not by writing rows directly.
Every seeded ticket is provably reachable by a real user — no hand-written state machine
in the seed script that could drift. (`docs/decisions.md` 14)

## Goal completion

All 10 goals are complete. Two documented deviations from the brief's authorization
matrix, both argued in `docs/decisions.md`:

| # | Goal | Status | Deviation |
|---|------|--------|-----------|
| 1 | Accounts and roles | Done | — |
| 2 | Tickets (CRUD, archive/restore) | Done | — |
| 3 | Replies | Done | — |
| 4 | Ticket lifecycle (state machine, SLA clock) | Done | — |
| 5 | Collaborators | Done | Supervisor-only (decision 3) |
| 6 | Search, filter, sort, pagination | Done | — |
| 7 | Bulk actions and CSV export | Done | — |
| 8 | Dashboard | Done | Added: personal row, week drill-down |
| 9 | Immutable history | Done | Trigger, not REVOKE (decision 13) |
| 10 | SLA alerts | Done | Scoped to assignee+collaborator (decision 12) |

Built beyond the ten goals: human-readable ticket keys (`SUP-14`), an unassigned-tickets
view (supervisor-only, with live badge), per-IP and per-email login throttling, and
session-expiry handling.

## Security model

- **Authentication:** JWT in an `httpOnly` cookie. The token proves identity; the user's
  role is re-read from the database on every request, so a role change takes effect
  immediately.
- **Authorization:** Three middleware layers — `authenticate` (is the token valid?),
  `requireRole` (is this user a supervisor?), `requireTicketAccess` (is this their
  ticket?). Each returns a distinct status code (401/403).
- **CSRF:** A separate middleware rejects state-changing requests whose `Origin` header
  names a different domain. CORS alone doesn't cover this — a cross-site form POST is a
  simple request with no preflight.
- **Immutability:** `ticket_events` is append-only via database trigger.
- **Headers:** `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, HSTS in
  production. `x-powered-by` is disabled.

## Testing

- **~350 server tests** (Vitest + Supertest) against a real Postgres database — no mocks.
  Tests exercise transactions, constraints, and the state machine through HTTP.
- **~90 client tests** (Vitest + Testing Library) — smoke tests for rendering and
  interaction.
- **Negative-case testing:** `authorization.test.ts` and `hardening.test.ts` prove every
  route refuses unauthorized access. The state machine tests cover every illegal
  transition.
- **Concurrency tests:** `concurrency.test.ts` verifies racing status changes resolve
  correctly.
- **Immutability tests:** `eventsImmutable.test.ts` confirms the trigger blocks UPDATE and
  DELETE.

## Known limitations and what's next

The SLA clock lives in Node, not SQL. `computeSla()` runs in application code, so
the database cannot filter or aggregate by breach status — the queue's breaching filter
reads the entire in-progress set and filters afterwards. At 60 tickets this is free; at
6,000 it is a full scan. The fix is a stored `breach_at` timestamp, indexed, which turns
the filter into `WHERE breach_at < now()`. The schema already has `clock_started_at` as
the seam for this migration.

This is the limitation I would fix first. It propagated into three features (queue filter,
dashboard count, alerts list) before I recognized it as architectural, and I had the
`findInProgressTickets()` helper built to work around it — a reasonable response whose
existence is the tell that I was routing around the design rather than fixing it. Under a
12-hour budget, that was the right call for the deadline and the wrong one for the
codebase.

After that: ship the duplicate blocking that `decisions.md` 9 committed to, and collapse
the acknowledgement model from three columns to two.

## How to run

See `README.md` for full setup instructions, environment variables, and project structure.

## Time spent

~15–18 hours across five days (1–5 September). The overrun against the 12-hour guide is
concentrated in deployment (four failures, none reproducible locally, culminating in the
iOS cookie problem) and a UI rebuild in the final session.

## Where the reasoning is

- `docs/decisions.md` — 15 decisions, each with what was rejected and why
- `docs/architecture.md` — the moving pieces, one request traced end to end
- `docs/schema.md` — every table, every constraint, what breaks first at scale
- `docs/plan.md` — how the work split across sessions, estimates versus reality
- `docs/ai-prompts.md` — AI-assisted development log
