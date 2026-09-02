# Architecture

*Written as Phase 2 completed. Phases 3–6 (collaborators, search and bulk actions,
dashboard and alerts, deployment) are not built yet; where that matters below, it says so.*

## The moving pieces

Three, plus a fourth that only exists during tests.

**The browser app** — React 19 with TypeScript, built by Vite, using React Router for
navigation. It holds no business rules. It renders what the API gives it and sends back
what the user typed.

**The API** — Express 5 with TypeScript, talking to Postgres through Prisma. Every rule
in the brief lives here: who may see a ticket, which status moves are legal, when a
reopen window has closed. Nothing is enforced only in the interface.

**The database** — Postgres, hosted on Supabase. It holds the data and enforces the
constraints that must never be violated regardless of what the application does:
foreign keys, uniqueness, enum values.

**A second database** — a separate Supabase project used only by the test suite. Tests
run against real Postgres rather than mocks, so they exercise real transactions and real
constraints; keeping it separate means they can create and delete freely without touching
demo data, and a dashboard test can assert exact counts.

### How they talk

The browser talks to the API over HTTP with JSON, and nothing else. There is one place in
the client that makes requests — `client/src/lib/api.ts` — which attaches the session
cookie to every call and converts a non-2xx response into a thrown error carrying the
server's own message. That is why a refused action shows the user "Only a supervisor can
close a ticket" rather than a generic failure.

The API talks to Postgres through Prisma, using the `@prisma/adapter-pg` driver adapter
that Prisma 7 requires.

**Authentication is a JWT in an httpOnly cookie.** The browser cannot read it, which rules
out the whole class of token-theft-by-script problems that `localStorage` invites. The
cost is that the client cannot tell whether it is logged in by inspecting anything locally
— on load it has to ask the server, which is what `GET /api/auth/me` is for.

## Where each piece runs

| Piece | In development | After deployment (Phase 6) |
|---|---|---|
| Browser app | Vite dev server on `:5173` | Vercel |
| API | `tsx watch` on `:3000` | Render |
| Database | Supabase (dev project) | the same Supabase project |
| Test database | Supabase (separate project) | not deployed |

In development the Vite dev server proxies `/api` to `localhost:3000`, so the browser
sees a single origin and cookies behave exactly as they will in production. After
deployment the two are genuinely cross-origin, which is why the API sets CORS with
`credentials: true` against an explicit `CLIENT_URL` rather than a wildcard — a wildcard
origin is not allowed to carry credentials at all.

## One request, end to end: an agent resolves a ticket

1. The agent clicks **Resolve**. That button exists only because the ticket payload's
   `allowed_transitions` contained `"resolved"` — the page has no rules of its own.
2. `api.post('/api/tickets/<id>/status', { status: 'resolved' })` sends the request with
   the session cookie attached.
3. Express parses the cookie. The `authenticate` middleware verifies the JWT and attaches
   `req.user`; a missing or expired token stops here with a 401.
4. `requireTicketAccess` asks whether this user may touch this ticket — supervisors always
   may, agents only if they are the assignee or a collaborator. Otherwise 403.
5. The route loads the ticket. If it is archived, 409: archived tickets are frozen.
6. `checkTransition('resolved', …)` consults the state machine. `open → resolved` is in
   the table and carries no extra guard, so it passes. Had this been `resolved → closed`
   from an agent, it would have returned 403 here; had it been `new → resolved`, 409.
7. **One transaction**: the ticket is updated with `status = resolved` and
   `resolved_at = now()`, and a `ticket_events` row recording `open → resolved` and who
   did it is inserted. Both or neither — a status can never change without its history.
8. The route reloads the ticket, recomputes `allowed_transitions` for this user and its
   SLA standing, and returns the whole thing.
9. The page re-renders from that response. The buttons now read **Reopen** — and, for an
   agent, still no **Close**.

Steps 3, 4 and 6 are three separate questions — *are you logged in*, *is this your
ticket*, *is this move legal* — and each has its own answer and its own status code.

## Layout of the code

```
server/src/
  app.ts                     Express wiring, CORS, routers, error handler
  index.ts                   starts the server
  lib/prisma.ts              the Prisma client
  lib/config.ts              REOPEN_WINDOW_DAYS, WARNING_WINDOW_MINUTES
  middleware/auth.ts         authenticate, requireRole, requireTicketAccess
  features/auth/             login, logout, me
  features/agents/           the agent roster a supervisor assigns from
  features/tickets/
    tickets.routes.ts        create, list, read, edit, archive, restore, duplicate check
    replies.routes.ts        replies, including the customer-reply auto-reopen
    status.routes.ts         the one endpoint that changes status
    stateMachine.ts          pure: which moves are legal, and why not
    sla.ts                   pure: elapsed, breach, warning, alert_active
    clock.ts                 pure: how much paused time to credit
    events.ts                writeEvent — the only way history is written
    detail.ts                the one definition of a ticket's API shape

client/src/
  lib/api.ts                 the only place that calls the server
  lib/format.ts              relative times, durations, labels
  types.ts                   the API contract in TypeScript
  context/AuthContext.tsx    session state
  components/                Badges, ActivityFeed, ReplyForm, StatusActions, Layout
  pages/                     Login, Queue, TicketDetail, NewTicket, Dashboard (stub)
```

Routes are grouped by feature rather than by kind, so everything about tickets sits
together. The pure modules — `stateMachine`, `sla`, `clock` — hold rules that are worth
testing without a database and worth reading without tracing a request.

There is deliberately no service or repository layer. Prisma is already a data-access
layer; wrapping it in another one would add a file to read for every change without
making a single rule clearer.

## Two things that are load-bearing and don't look it

**`server/src/test/setup.ts`** loads the test environment before any test module is
imported. It looks like boilerplate, but `import` statements are hoisted above everything
else in a module — so without it, the app would build its Prisma client before
`DATABASE_URL` existed and quietly try to connect to localhost. A standalone script hit
exactly this and failed with `ECONNREFUSED`. Do not delete it as noise.

**Route declaration order.** `/api/tickets/duplicate-check` is declared before
`/api/tickets/:id`, and `/tickets/new` before `/tickets/:id` in the client router.
Reversed, Express and React Router would both read the literal path segment as an id.

## What was deliberately not built

**Email ingestion.** The brief's scenario is a group inbox, but none of the ten goals asks
the system to read mail. Agents create tickets from the inbox by hand, and later customer
emails are logged as replies with `author_type: 'customer'`. Building inbound mail would
need webhooks or IMAP polling, parsing, and reply-threading heuristics — plausibly more
work than the other nine goals together, on infrastructure free tiers make awkward.

**Self-registration.** There is no sign-up page. The brief describes an internal tool with
two roles; accounts come from the seed script.

**A repository layer over Prisma.** See above.

**A separate "customer view" of a ticket.** The brief allows either hiding internal notes
behind a filter or flagging them clearly. Internal notes are always returned with
`is_internal: true` and rendered with a distinct border and label. One code path, no risk
of the filter being the only thing standing between an internal note and a customer.

**Duplicate blocking.** The system warns that a requester already has open tickets but
does not refuse the second one. This has since been reversed as a decision — see
`decisions.md` — but the code still warns rather than blocks at the time of writing.

**Ticket keys like `SUP-14`.** Tickets are identified by UUID. A human-readable key was
considered and deferred to Phase 4, when the queue table and CSV export make readability
matter more.
