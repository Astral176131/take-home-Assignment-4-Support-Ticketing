# Submission

Fill this in and commit it. This is the first file we open.

## Links

- **GitHub repository:** https://github.com/Astral176131/take-home-Assignment-4-Support-Ticketing
- **Live application:** https://take-home-assignment-4-support-tick.vercel.app

## Notes for the reviewer

**The API sleeps.** It runs on Render's free tier and spins down after 15 minutes of
inactivity. The first request after that takes 30–60 seconds while the container wakes. A slow
first sign-in is that, not a broken deployment. Everything after it is fast.

**Where the thinking is.** This file is deliberately short. The reasoning lives in `docs/`:

- `docs/decisions.md` — 15 decisions, each with what was rejected and why. Decisions 3, 9, 10
  and 12 are the ones where I knowingly departed from the brief; decision 9 is one I reversed.
- `docs/architecture.md` — the moving pieces, one request traced end to end, and what I
  deliberately didn't build.
- `docs/schema.md` — every table, which constraints live in the database versus the
  application, and what breaks first at 100× the data.
- `docs/plan.md` — how the work actually split across sessions, estimates versus reality.

**Mobile was broken until late.** The client and API sit on different domains, which made the
session cookie third-party. Desktop Chrome kept it; iOS Safari discarded it outright, so
sign-in appeared to succeed and every subsequent request came back "Authentication required."
The fix was to proxy `/api/*` through the client's own origin so the cookie is first-party
(`docs/decisions.md`, decision 15). Worth knowing because it's the kind of bug that only exists
once something is genuinely deployed.

**Two deviations from the brief you'll notice immediately**, both argued in `decisions.md`:
collaborator management is supervisor-only rather than open to the assignee (decision 3), and
the alerts list includes tickets you collaborate on rather than only ones assigned to you
(decision 12).

## Demo credentials

| Role | Email | Password |
|------|-------|----------|
| Supervisor | supervisor1@example.com | super123 |
| Agent | agent1@example.com | agent123 |

There are six seeded accounts in total — `supervisor2@example.com` / `super456`, and
`agent2@example.com` / `agent456` through `agent4@example.com` / `agent101`. Signing in as
different agents is the quickest way to see the authorization rules do something: an agent sees
only their own tickets in the queue, and gets a 403 from any ticket they don't hold.

## Stack

| Layer | What you used | Why |
|-------|---------------|-----|
| Frontend | React 19 + TypeScript, Vite, React Router 7 | A plain SPA against a JSON API keeps "where does a rule live" unambiguous — never the frontend. No server-rendering requirement here to justify Next.js, and Vite's dev server kept the feedback loop fast. |
| Backend | Express 5 + TypeScript, Prisma 7 (`@prisma/adapter-pg`) | Express is minimal and unopinionated, so the state machine and authorization rules are plain functions rather than framework machinery. Prisma gave typed queries against a schema that changed constantly; the driver adapter is Prisma 7's requirement, not a preference. |
| Database | Postgres on Supabase, plus a second Supabase project for tests | The data is relational and the constraints matter — a unique index on `requesters.email` is what turned a silent data-corruption race into a loud, recoverable conflict. Tests run against real Postgres in their own project so they can create and delete freely and assert exact dashboard counts. |
| Hosting | Vercel (client), Render (API), Supabase (database) | Three free tiers, deployed in dependency order: database first, then the API with its connection string, then the client pointed at the API. Vercel also proxies `/api/*` to Render so the session cookie stays first-party. |

## Goal checklist

Mark each honestly. Partial is fine — say what is partial.

| # | Goal | Status | Notes |
|---|------|--------|-------|
| 1 | Accounts and roles | Done | Email + password, JWT in an `httpOnly` cookie. Every rule is enforced server-side; `authorization.test.ts` asserts, route by route, that the disallowed actor is refused with the right status code. Agents cannot reassign away from themselves. |
| 2 | Tickets | Done | Create, edit, archive, restore. Archived tickets leave every default view but keep their history and stay readable; every mutation on one is refused with a 409. |
| 3 | Replies inside tickets | Done | Body, author, timestamp, and an internal-note flag. Internal notes are always returned flagged and rendered distinctly rather than filtered out — one code path, so a filter bug can't leak one to a customer. |
| 4 | Ticket lifecycle | Done | Full state machine with the pending clock pause, customer-reply auto-reopen, and a 7-day reopen window. Illegal moves are refused with a reason and a status code that distinguishes "nonsense" (400) from "not allowed" (403) from "not in a state where that's possible" (409). |
| 5 | Collaborators | Done, with a deviation | Works as specified, except that adding and removing collaborators is supervisor-only. The brief's matrix grants it to the assignee too — but it also forbids that agent from reassigning, and collaborator management is a side door to the same outcome. Argued in `decisions.md` 3. |
| 6 | Finding tickets | Done | Server-side search over subject, description and requester name (trigram-indexed), filters for status/priority/category/assignee/archived/breaching, three sort fields, and pagination with a server-clamped page size. Nothing is filtered in the browser. |
| 7 | Bulk actions and CSV | Done | Bulk reassign, close, and add/remove collaborator. Every batch returns a per-ticket report of what succeeded and what was refused with the reason — never all-or-nothing. CSV export streams row by row and reuses the queue's exact query builder, so the export and the list can't disagree about what a filter means. |
| 8 | Dashboard | Done, plus extras | The required headline numbers, status and agent breakdowns, and the 8-week chart. Added beyond the brief: a personal row scoped to the viewer, an unassigned count, and clicking any week to drill into that week's day-by-day breakdown in place. |
| 9 | History you cannot rewrite | Done | Enforced by a Postgres trigger that raises on any `UPDATE` or `DELETE`, not merely by the absence of a route. The build prompt suggested revoking grants; I checked first and found the app's role *owns* the table, so a revoke would have been a silent no-op. `decisions.md` 13. |
| 10 | SLA alerts | Done, with a deviation | Alerts list, nav badge, and acknowledgement. Two departures: the list is scoped to assignee-or-collaborator rather than assignee-only, matching who may acknowledge (`decisions.md` 12); and acknowledging is a 60-minute snooze rather than permanent silence, so an acknowledged ticket nobody then fixes comes back rather than disappearing. |

Not asked for, but built: human-readable ticket keys (`SUP-14`), a supervisor-only view of
unassigned tickets, per-IP and per-email login throttling, and session-expiry handling that
signs you out instead of leaving the app rendering its own navigation over a wall of 401s.

## How much time did you actually spend?

Roughly 15–18 hours across five days (1–5 September), in about nine sessions. That's over the
12-hour guide, and the overrun is concentrated in two places rather than spread evenly.

The first is deployment. Getting three free tiers to agree took far longer than building
against localhost: a build that failed because setting `NODE_ENV=production` made Render skip
the devDependencies needed to compile TypeScript, a client that 404'd every route on refresh
until Vercel was told to serve `index.html`, and the third-party cookie problem that only
appeared on a phone. None of that is visible in the feature list.

The second is that I rebuilt the UI once, in the last session, after the first pass turned out
to be functional but unpleasant to actually use.

## What would you do next, with another 12 hours?

Move SLA breach evaluation out of Node and into SQL.

Right now `computeSla()` runs in application code over rows that Postgres has already returned.
It's correct and it's well-tested, but the database has no idea what "breaching" means — so
filtering the queue to breaching tickets reads the entire in-progress set and discards most of
it, and the dashboard's breaching count does the same. At sixty tickets that's free. It stops
being free well before it stops being correct.

The fix is a stored `breach_at` timestamp on the ticket row, maintained by the same function
that computes the clock today, and indexed. That turns "everything breaching" into a `WHERE
breach_at < now()` over an index instead of a full scan plus a filter in Node, and it makes
things that are currently impossible merely straightforward: alerting on what will breach in
the next hour, SLA-based routing, automatic escalation.

The schema already anticipated this — `clock_started_at` exists as a column precisely so the
clock could one day be expressed in SQL rather than replayed from the event history
(`decisions.md` 6). So this is a retrofit along a seam that's already there, not a rewrite.

After that, in order: ship the duplicate blocking that `decisions.md` 9 committed to and never
delivered, and collapse the acknowledgement model from three columns to two.

## What are you least happy with in this codebase, and why?

The SLA clock living in Node.

It is the most important computation in the system — it decides what's breaching, what's
warning, what alerts, and what the dashboard reports — and it is the one piece Postgres cannot
see. Everything downstream is shaped around that. The queue's breaching filter can't be a
`WHERE` clause, so it reads the whole scoped set and filters afterwards. The dashboard's
breaching count can't be an aggregate, so it fetches every in-progress ticket and counts in
JavaScript. The alerts list does the same work a third time.

What bothers me isn't the performance — at this size it's irrelevant, and I'd make the same
call again under a 12-hour budget, because getting the pause-and-reopen arithmetic right in one
readable, unit-testable function was worth more than making it queryable. What bothers me is
that a limitation propagated into the shape of three separate features before I noticed it had
become architectural. `findInProgressTickets()` exists as a shared helper specifically because
three call sites all needed the same workaround. That helper is a reasonable response to the
problem, but its existence is the tell: I was routing around the design rather than fixing it.

The honest version is that I saw it early — it's written down in `schema.md` under "what breaks
first at 100× the data," in the same session the clock was built — and chose to keep going.
That was the right call for the deadline and the wrong one for the codebase.
