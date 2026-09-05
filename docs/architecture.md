# Architecture

All six phases are built and deployed. Where something is a known limitation rather than a
finished thought, it says so.

## The moving pieces

Four, plus a fifth that only exists during tests.

**The browser app** — React 19 with TypeScript, built by Vite, routed by React Router. It holds
no business rules. It renders what the API gives it and sends back what the user typed. The one
thing resembling a rule on this side is which buttons to show, and even that is a list the
server computes (`allowed_transitions`) rather than logic the client owns.

**Vercel's edge, as a proxy.** Not a piece of code I wrote, but load-bearing: `client/vercel.json`
rewrites `/api/*` to the Render service. The browser therefore only ever talks to one origin.
This exists for one reason — the session cookie — covered under "how they talk" below.

**The API** — Express 5 with TypeScript, talking to Postgres through Prisma 7. Every rule in
the brief lives here: who may see a ticket, which status moves are legal, when a reopen window
has closed, whether an alert is currently firing. Nothing is enforced only in the interface.

**The database** — Postgres on Supabase. It holds the data and enforces what must be true of a
row regardless of which code path wrote it: foreign keys, uniqueness, enum membership, and one
trigger that makes `ticket_events` append-only even against the application's own database role.

**A second database** — a separate Supabase project used only by the test suite. Tests run
against real Postgres rather than mocks, so they exercise real transactions and real
constraints. Keeping it separate means tests can create and delete freely without touching demo
data, and a dashboard test can assert exact counts.

### How they talk

The browser talks to the API over HTTP with JSON and nothing else. There is one place in the
client that makes requests — `client/src/lib/api.ts` — which attaches the session cookie to
every call and converts a non-2xx response into a thrown error carrying the server's own
message. That is why a refused action shows the user "Only a supervisor can close a ticket"
rather than a generic failure.

The API talks to Postgres through Prisma, using the `@prisma/adapter-pg` driver adapter that
Prisma 7 requires.

**Authentication is a JWT in an `httpOnly` cookie.** The browser cannot read it, which rules out
token-theft-by-script entirely. Two consequences follow:

1. The client cannot tell whether it is signed in by inspecting anything locally. On load it
   asks the server — that is what `GET /api/auth/me` is for.
2. The cookie has to be first-party, or browsers throw it away. This is the single hardest
   problem the deployment posed. The client is on `vercel.app` and the API on `onrender.com`:
   different registrable domains, so the cookie was third-party. Desktop Chrome accepted it
   with `Secure`, `SameSite=None` and an exact-origin CORS policy. iOS Safari discarded it
   outright, and every browser on iOS is Safari underneath. Rather than move the token to
   `localStorage` — trading a cookie a script cannot read for one it can, to solve a hosting
   problem — the fix routes `/api/*` through Vercel to Render, making the browser's request
   same-origin and the cookie first-party. `decisions.md` 15 has the full reasoning and the two
   things it depends on.

The API is still hardened as if it were reachable cross-origin, because it is: CORS is pinned
to an exact `CLIENT_URL` with `credentials: true` (a wildcard origin is not permitted to carry
credentials at all), and a separate middleware refuses any state-changing request whose
`Origin` header names somewhere else. CORS alone would not cover that — a cross-site form POST
is a "simple request" with no preflight, so the side effect has already happened by the time
CORS is consulted.

## Where each piece runs

| Piece | In development | Deployed |
|---|---|---|
| Browser app | Vite dev server on `:5173` | Vercel — https://take-home-assignment-4-support-tick.vercel.app |
| API | `tsx watch` on `:3000` | Render — https://take-home-assignment-4-support-ticketing-f3wf.onrender.com |
| Database | Supabase (dev project) | the same Supabase project |
| Test database | Supabase (separate project) | not deployed |

In development, Vite proxies `/api` to `localhost:3000`; in production, Vercel proxies `/api`
to Render. The browser sees one origin in both cases, so cookies behave the same locally as
they do live — which is exactly the property that was missing when the cookie bug appeared only
after deployment.

Render's free tier spins the API down after 15 minutes idle. The first request afterwards pays
a 30–60 second cold start, now from behind Vercel's proxy rather than directly.

## One request, end to end: an agent resolves a ticket

1. The agent clicks **Resolve**. That button exists only because the ticket payload's
   `allowed_transitions` contained `"resolved"` — the page has no rules of its own.
2. `api.post('/api/tickets/<id>/status', { status: 'resolved' })` sends the request. The path is
   relative, so it goes to the Vercel origin and is rewritten to Render, carrying the session
   cookie.
3. The CSRF middleware checks the `Origin` header against `CLIENT_URL`. A request from anywhere
   else is refused with 403 before any handler runs.
4. `authenticate` verifies the JWT and looks the user up by id. The lookup is deliberate: the
   signature proves the token was issued here, but not that the user still exists or still holds
   the role the token was minted with. A missing, expired or invalid token stops here with 401.
5. `requireTicketAccess` asks whether this user may touch this ticket — supervisors always may,
   agents only if they are the assignee or a collaborator. Otherwise 403, with the same message
   whether the ticket is inaccessible or doesn't exist, so ticket ids can't be enumerated.
6. The route loads the ticket. If it is archived, 409 — archived tickets are frozen.
7. `checkTransition('resolved', …)` consults the state machine. `open → resolved` is in the
   table and carries no extra guard, so it passes. Had this been `resolved → closed` from an
   agent it would have returned 403 here; `new → resolved`, 409.
8. **One transaction**: the ticket is updated with `status = resolved` and `resolved_at = now()`,
   and a `ticket_events` row recording `open → resolved` and who did it is inserted. Both or
   neither — a status can never change without its history.
9. The route reloads the ticket, recomputes `allowed_transitions` for this user and its SLA
   standing, and returns the whole thing.
10. The page re-renders from that response. The buttons now read **Reopen** — and, for an agent,
    still no **Close**.

Steps 4, 5 and 7 are three separate questions — *are you signed in*, *is this your ticket*, *is
this move legal* — each with its own answer and its own status code.

## Layout of the code

```
server/src/
  app.ts                       Express wiring: CORS, CSRF origin check, security headers,
                               routers, JSON 404, central error handler
  index.ts                     starts the server
  lib/prisma.ts                the Prisma client and its pg pool
  lib/jwt.ts                   getJwtSecret + cookieOptions, shared by login and logout so
                               their cookie attributes cannot drift apart
  lib/config.ts                REOPEN_WINDOW_DAYS (7), WARNING_WINDOW_MINUTES (15),
                               ACK_SNOOZE_MINUTES (60)
  lib/purgeTicketEvents.ts     the only sanctioned way past the immutability trigger; used by
                               test cleanup, never by application code
  middleware/auth.ts           authenticate, requireRole, requireTicketAccess
  features/auth/               login, logout, session probe, per-IP and per-email throttling
  features/agents/             the agent roster a supervisor assigns from
  features/alerts/             the alerts list
  features/dashboard/          headline counts, personal counts, 8-week series, week drill-down
    weeks.ts                   pure: UTC Monday-start week bucketing
  features/tickets/
    tickets.routes.ts          create, list, /mine, /unassigned, read, edit, archive, restore,
                               duplicate check
    replies.routes.ts          replies, including the customer-reply auto-reopen from pending
    status.routes.ts           the one endpoint that changes status
    collaborators.routes.ts    add and remove collaborators (supervisor-only)
    reassign.routes.ts         reassignment (supervisor-only)
    bulk.routes.ts             bulk reassign, close, collaborators — per-ticket reports
    ack.routes.ts              acknowledge an active alert
    export.routes.ts           streamed CSV, reusing the queue's own query builder
    query.ts                   buildTicketWhere / resolveTicketSort / resolvePagination —
                               one definition of what a filter means, shared by list and export
    stateMachine.ts            pure: which moves are legal, and why not
    sla.ts                     pure: elapsed, breached, warning, alert_active, snooze
    clock.ts                   pure: how much paused time to credit
    concurrency.ts             guardedUpdate — conditional writes for racing requests
    events.ts                  writeEvent — the only way history is written
    alertCandidates.ts         findInProgressTickets — the shared set the dashboard count and
                               the alerts list both start from
    detail.ts                  the one definition of a ticket's API shape

client/src/
  lib/api.ts                   the only place that calls the server; also raises a
                               session-expired event on an unexpected 401
  lib/useTicketQuery.ts        filter/sort/page state, held in the URL so a filtered list is
                               a place you can link to
  lib/format.ts                relative times, durations, labels
  types.ts                     the API contract in TypeScript
  context/AuthContext.tsx      session state
  context/AlertsContext.tsx    the alert count, shared by the nav badge and the alerts page
  context/UnassignedContext.tsx the unassigned count, supervisor-only
  components/                  TicketTable, TicketFilters, Pagination, BulkActionBar,
                               StatStrip, BarChart, Badges, ActivityFeed, ReplyForm,
                               StatusActions, TicketPeople, TicketEditForm, Layout
  pages/                       Login, Dashboard, Queue, TicketDetail, NewTicket, MyTickets,
                               Unassigned, Alerts, NotFound
```

Routes are grouped by feature rather than by kind, so everything about tickets sits together.
The pure modules — `stateMachine`, `sla`, `clock`, `weeks` — hold rules worth testing without a
database and worth reading without tracing a request.

There is deliberately no service or repository layer. Prisma is already a data-access layer;
wrapping it in another would add a file to read for every change without making a single rule
clearer.

## Four things that are load-bearing and don't look it

**`server/src/test/setup.ts`** loads the test environment before any test module is imported.
`import` statements are hoisted above everything else in a module, so without it the app would
build its Prisma client before `DATABASE_URL` existed and quietly try to connect to localhost.
This project hit that trap three separate times — a standalone script, the seed script, and test
tooling — each time with a confusing `ECONNREFUSED`. Do not delete it as noise.

**Route declaration order, in three places.** `/api/tickets/duplicate-check`, `/mine` and
`/unassigned` are all declared before `/api/tickets/:id`, or Express reads the literal segment
as an id. `exportRouter` is mounted before `ticketsRouter` for the same reason. In the client
router, `/tickets/new` precedes `/tickets/:id`. And in `vercel.json`, the `/api/*` rewrite must
come before the SPA catch-all, or every API call is served `index.html`.

**`router.use()` is prefix-wide, not router-wide.** `bulk.routes.ts` once carried a blanket
`router.use(requireRole('supervisor'))`. Because several routers mount at the same
`/api/tickets` prefix, that middleware ran for *every* request reaching the prefix — including
ones another router would eventually handle. It was invisible for two commits and surfaced only
when agent acknowledgement started failing with a message that appears nowhere in
`ack.routes.ts`. Role checks are now attached per route.

**`guardedUpdate`.** Several writes are conditional on the ticket still being in the state the
handler read. A customer reply and a manual resume arriving together both used to credit the
same pending interval, doubling the paused time and pushing a real breach back under target.
The condition is what makes exactly one of them win.

## What was deliberately not built

**Email ingestion.** The brief's scenario is a group inbox, but none of the ten goals asks the
system to read mail. Agents create tickets by hand and log later customer emails as replies with
`author_type: 'customer'`. Inbound mail would need webhooks or IMAP polling, parsing, and
reply-threading heuristics — plausibly more work than the other nine goals together, on
infrastructure free tiers make awkward.

**Self-registration.** No sign-up page. The brief describes an internal tool with two fixed
roles; accounts come from the seed script.

**A repository layer over Prisma.** See above.

**A separate customer-facing view of a ticket.** Internal notes are always returned flagged and
rendered with a distinct border and label, rather than filtered out server-side for some
audiences. One code path means no risk of a filter being the only thing between an internal note
and a customer.

**Duplicate blocking.** The system shows an agent the requester's existing open tickets before
they file, but does not refuse the second one. `decisions.md` 9 records this being reversed as a
decision and deliberately not shipped: it isn't one of the ten goals, and the brief is explicit
that finishing fewer goals properly beats leaving all ten half-done.

**SLA breach as a SQL expression.** The clock is computed in Node. This is the known
architectural limitation, described in `schema.md` and named in `SUBMISSION.md` as the first
thing to fix with more time.
