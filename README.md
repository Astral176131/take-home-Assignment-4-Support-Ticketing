# Support Ticketing

A shared support queue for a small team that currently handles customer requests over email,
by hand. Agents pick up tickets, reply, and move them through a fixed lifecycle
(`new → open → pending → resolved → closed`); a supervisor can reassign work, close tickets,
and see the whole queue. Every ticket carries a response-time target set by its priority, and
anything at risk of breaching that target shows up as an alert, not something a person has to
notice by scanning timestamps.

## Live deployment

- **App:** https://take-home-assignment-4-support-tick.vercel.app
- **API:** https://take-home-assignment-4-support-ticketing-f3wf.onrender.com

Both run on free tiers. The API spins down after 15 minutes of inactivity — the first request
after that can take 30–60 seconds to wake it up. That's a hosting limit, not a bug.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 19 + TypeScript, built by Vite | a plain SPA against a JSON API keeps "where does a rule live" unambiguous — never the frontend — and Vite's dev server is fast enough that the feedback loop was never the bottleneck |
| Routing | React Router 7 | client-side routing for a single-page app; no server-rendering requirement to justify Next.js |
| Backend | Express 5 + TypeScript | minimal and unopinionated — the state machine and authorization rules are plain functions, not framework decorators or magic |
| ORM | Prisma 7, via `@prisma/adapter-pg` | typed queries against a schema that changed constantly during development; the driver adapter is Prisma 7's new requirement for a `pg` connection, not a choice |
| Database | Postgres, hosted on Supabase | relational data with real foreign keys and a unique-constraint-shaped bug (see `docs/decisions.md`, decision 1) that a document store wouldn't have caught the same way |
| Auth | Hand-rolled email + password, JWT in an `httpOnly` cookie | the whole auth surface is a handful of files; a library like Passport or Auth.js buys machinery for OAuth providers and session stores this project never needed |
| Password hashing | `bcryptjs` | pure JavaScript — no native build step, which matters on Render's free-tier build environment |
| Testing | Vitest + Supertest, against a real second Postgres database | the rules worth testing here are transactional and constraint-shaped (a status change and its history row landing together, a unique index rejecting a duplicate); a mocked ORM would only prove the code calls the functions it calls |
| Hosting | Render (API), Vercel (client), Supabase (database) | three free tiers, deployed in the order the database's connection details are needed by the next piece |

## Features

- Sign in as an agent or a supervisor. Every rule below is enforced server-side — hiding a
  button in the UI is never the only thing standing between a user and an action they
  shouldn't be able to take.
- Create, edit, archive and restore tickets with a subject, description, requester, priority
  and category.
- Reply to a ticket, or log a customer's reply on their behalf, marking either as an internal
  note or a customer-visible message.
- Move a ticket through its lifecycle. Illegal moves (closing as an agent, reopening past the
  window, moving to a status that doesn't follow from the current one) are refused with a
  reason, not silently ignored.
- Add collaborators to a ticket (supervisor-only) and see one list of every ticket you hold as
  assignee or collaborator.
- Search, filter, sort and page through the queue entirely server-side, and export the
  currently filtered view as a CSV.
- Select several tickets and bulk-reassign or bulk-close them in one action, with a per-ticket
  report of what succeeded and what was refused.
- See a dashboard: headline counts, a personal breakdown of your own tickets, a breakdown by
  status and by agent, and a chart of tickets resolved per week for the last 8 weeks —
  click any week to drill into that week's daily breakdown, in place, without leaving the page.
- See every ticket nobody has picked up yet (supervisor-only) and route it to an agent.
- Get alerted when a ticket breaches its response target or is about to, with a count badge in
  the navigation; acknowledge an alert to silence it for an hour, or until the ticket is
  reopened.
- Read a full, unchangeable timeline of every status change, reassignment and reply on a
  ticket — nothing in it can be edited or deleted, including by a supervisor.

## Prerequisites

- **Node.js 22** (developed against `v22.14.0`)
- **npm 10** (developed against `10.9.2`)
- A **Postgres database** you can reach — this project used two separate Supabase projects
  (one for development, one for the test suite). Any reachable Postgres connection string
  works.

## Setup

```bash
# 1. Clone and enter the repo
git clone https://github.com/Astral176131/take-home-Assignment-4-Support-Ticketing.git
cd take-home-Assignment-4-Support-Ticketing

# 2. Install dependencies — client and server are separate npm projects, not a workspace
cd server && npm install
cd ../client && npm install
cd ..

# 3. Configure the server's environment
#    Create server/.env with at least DATABASE_URL and JWT_SECRET (see the table below)

# 4. Apply migrations
npm run migrate

# 5. Seed demo data (50 tickets, 6 users, 20 customers)
npm run seed

# 6. Run the app (two terminals)
npm run dev:server   # API on :3000
npm run dev:client   # client on :5173, proxies /api to :3000
```

Open `http://localhost:5173` and sign in with one of the seeded accounts (see
`SUBMISSION.md` for the full list).

## Environment variables

### `server/.env`

| Name | Required | Purpose | Example |
|---|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string | `postgresql://user:pass@host:5432/postgres` |
| `JWT_SECRET` | yes | signs and verifies the session cookie's JWT | a long random string — generate one with `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `PORT` | no | port the API listens on | `3000` (default) |
| `NODE_ENV` | no | `production` switches the cookie to `Secure`/`SameSite=None` and enables HSTS | `development` (default) |
| `CLIENT_URL` | no in dev, yes in production | the single origin CORS and the CSRF check allow | `http://localhost:5173` (default) |

### `server/.env.test`

Same shape as `server/.env`, pointed at a **separate** database — the test suite creates and
deletes rows freely and must never touch development data.

### `client` (Vercel environment variables, build-time)

| Name | Required | Purpose | Example |
|---|---|---|---|
| `VITE_API_URL` | no — leave unset | absolute API origin, only needed if the client and API are cross-origin **and** the deployment isn't proxying `/api/*` through the client's own domain (see `docs/decisions.md`, decision 15). This deployment proxies instead, so it's unset. | *(leave empty)* |

Nothing above is a real value used in this project's own deployment — every credential lives
in Render's and Vercel's environment variable settings, never in the repository.

## Running dev, build, and tests

```bash
# Dev servers (from the repo root)
npm run dev:server
npm run dev:client

# Production build
cd server && npm run build   # tsc -> dist/
cd client && npm run build   # tsc -b && vite build -> dist/

# Tests — both require their respective .env.test / .env to point at a real reachable
# Postgres database; nothing is mocked
cd server && npm test        # Vitest + Supertest, ~350 tests
cd client && npm test        # Vitest + Testing Library, ~90 tests
```

## Project structure

```
server/
  prisma/
    schema.prisma            data model (see docs/schema.md)
    migrations/               8 migrations, applied in order
    seed.ts                   drives 50 demo tickets through the real API, not direct writes
  src/
    app.ts                    Express wiring: CORS, CSRF check, routers, error handler
    index.ts                  starts the server
    lib/                      Prisma client, JWT helpers, shared config
    middleware/auth.ts        authenticate, requireRole, requireTicketAccess
    features/
      auth/                   login, logout, session probe, login-attempt throttling
      tickets/                CRUD, replies, status, collaborators, reassignment, bulk
                               actions, CSV export, the state machine, SLA math
      agents/                 the agent roster a supervisor assigns from
      alerts/                 the SLA alerts list
      dashboard/               headline numbers, personal stats, the 8-week/daily charts

client/
  src/
    lib/api.ts                the one place that calls the server
    lib/useTicketQuery.ts     shared filter/sort/paging state, held in the URL
    context/                  auth session, live alert count, live unassigned count
    components/               shared building blocks (queue table, filters, badges, charts)
    pages/                    one file per route — Dashboard, Queue, Ticket detail,
                               My tickets, Unassigned, Alerts, New ticket, Login

docs/
  architecture.md             the moving pieces, request flow, what wasn't built
  schema.md                   every table, every constraint, what breaks first at scale
  decisions.md                 15 recorded decisions, what was rejected and why
  plan.md                     how the work was actually split and estimated
  ai-prompts.md                the prompts used, including the ones that went wrong
```

## Known limitations and what's next

- **The queue list has no upper bound on result size beyond page size** — at this project's
  scale (dozens of tickets) that's invisible; at 100x the data it's the first thing to fix
  (see `docs/schema.md`).
- **SLA breach status is computed in Node, not SQL** — correct, but means "show me only
  breaching tickets" reads the whole in-progress set before filtering. Fine at this scale.
- **No email ingestion** — tickets are logged by hand from an inbox; there's no webhook or IMAP
  polling turning an incoming email into a ticket automatically.
- **Duplicate tickets are warned about, not blocked** — seeing a customer's existing open
  tickets on the create form is as far as it goes; filing a genuine duplicate is still
  possible. See `docs/decisions.md`, decision 9, for the reasoning and what would change it.
- **Free-tier cold starts** — the first request to the API after 15 minutes of inactivity is
  slow. A paid tier or a keep-alive ping would fix it; neither seemed worth it for a graded
  demo.
