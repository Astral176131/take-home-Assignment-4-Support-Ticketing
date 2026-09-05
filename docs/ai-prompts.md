# AI-Assisted Development

I used Claude (via Claude Code and Antigravity IDE) for implementation acceleration
throughout this build. I set the requirements, made every architecture and product
decision, directed the implementation, reviewed output, ran migrations, tests and builds,
investigated every failure, and decided each fix. The engineering decisions are recorded
in `decisions.md`; this document covers the development workflow and the most instructive
interactions.

## Development workflow

```
Requirements (from the brief)
  → Architecture decisions (my calls, before code)
    → AI-assisted implementation
      → Review and correction
        → Testing against real Postgres
          → Debugging (every bug found by running, not by reading)
            → Deployment and validation on real devices
```

## Pre-implementation design session

Before any code existed, I gave Claude the full build prompt and directed it to interview
me on every decision it would otherwise make silently — repository layout, database
strategy, auth approach, backend structure, TypeScript runtime.

**Decisions I made in that session:**

- **Pure API + SPA, not a full-stack framework.** The brief requires server-side
  authorization enforcement. A JSON API makes "where does this rule live" unambiguously
  the server.
- **JWT in an `httpOnly` cookie.** Rejected `localStorage` — a token a script can read is
  a token XSS can steal. Accepted the cost: the client cannot know whether it is signed in
  without asking the server (`GET /api/auth/me`).
- **Feature-folder backend, no service/repository layers.** Initially accepted Claude's
  suggestion of controller/service/repository, then reversed it: Prisma is already a
  data-access layer, and wrapping it added files without making any rule clearer.
- **Postgres + Prisma with real constraints.** Relational data with real foreign keys and
  unique indexes, not application-level guarantees.

## Key engineering interactions

### Prisma 7 migration failures

**Direction:** Execute the approved scaffold — schema, auth, middleware, tests.

**Problem:** Claude generated a Prisma 5/6 schema. Prisma 7 had removed `url` from
`datasource`. Migration failed with `P1012`. Then the runtime adapter was initialized with
a connection string instead of a `pg.Pool`. Then a module-hoisting bug: `import` hoisted
the auth middleware's `JWT_SECRET` validation above `dotenv.config()`, so the server died
on boot.

**What I did:** Read the Prisma 7 migration guide, directed fixes across three files
(`schema.prisma`, `prisma.config.ts`, the runtime adapter), traced the import chain for
the hoisting bug, and directed a lazy `getJwtSecret()` evaluated on first use. The same
class of bug — import-time evaluation before environment loading — recurred in the seed
script and test setup.

---

### Fail-open authorization (Prisma undefined behavior)

**Direction:** Write a table-driven test that proves every route refuses the disallowed
actor, with the correct status code.

**What the review surfaced:** `checkTicketAccess` passed `userId` into a Prisma `where`
clause. Prisma silently drops `undefined` filter values instead of matching nothing — so
an absent id turned the collaborator lookup into "any collaborator" and would have allowed
a stranger through.

**Decision:** Made the helper fail closed: it rejects when `ticketId` or `userId` is
falsy, before Prisma is involved. Unreachable over HTTP (the id comes from a verified
JWT), but defense in depth. This is the bug class that only appears when you test the
negative case.

---

### Immutability: trigger over REVOKE

**Direction:** The build prompt suggested revoking `UPDATE`/`DELETE` grants on
`ticket_events`. Before implementing, I directed Claude to check whether that would
actually work.

**What it found:** The application's database role *owns* `ticket_events` (confirmed by
querying `current_user` against `tableowner` on both databases). A Postgres owner's
privileges are inherent — `REVOKE` would have been a silent no-op.

**Decision:** Implemented as a `BEFORE UPDATE OR DELETE` trigger instead, which fires for
any writer regardless of privilege level. Accepted the cost: the trigger also blocks test
cleanup, fixed with a single shared helper (`purgeTicketEvents`) that disables the trigger
via `ALTER TABLE` inside a transaction. Full reasoning in `decisions.md` 13.

---

### Express `router.use()` prefix-wide middleware leak

**Direction:** Implement bulk reassign and close with per-ticket partial results.

**Problem:** Claude placed `router.use(requireRole('supervisor'))` at the top of
`bulk.routes.ts`. It looked correct and was tested. But several routers mount at the same
`/api/tickets` prefix, and a path-less `router.use()` runs for *anything* reaching that
prefix — including routes another router handles. Invisible for two commits; surfaced when
the alert acknowledgement endpoint was added and every agent ack failed with "Insufficient
permissions" — a message that appears nowhere in `ack.routes.ts`.

**Fix:** The mismatch between the error message and the file it came from gave it away.
Role checks are now attached per route, matching every other supervisor-gated router.

---

### SLA clock design decisions

**Direction:** Implement the five-state lifecycle with the pending clock pause.

**Decisions I made, all rejections of simpler options:**

- `clock_started_at` as its own column, not overloaded into `paused_minutes` or replayed
  from events — keeps SLA expressible as SQL.
- Only `closed → open` restarts the clock — `resolved → open` undoes a premature resolve;
  restarting there would make resolve-then-reopen a way to erase a breach.
- `resolved_at` and `closed_at` survive a reopen — historical markers, not state flags.
  Nothing infers state from these columns; only `status` decides that.
- The server computes `allowed_transitions` and the client renders it — one copy of the
  rules, structurally unable to disagree.

---

### Seed data validation

**Direction:** Create 50 demo tickets driven through the real API, not direct Prisma
writes.

**Problems found by inspecting the output, not by errors:**

1. `npx prisma db seed` silently did nothing — Prisma 7 moved the seed command
   configuration, and the old `package.json` location was ignored. Found by running it
   and seeing nothing happen.
2. A flat 3-hour backdate didn't breach `high` priority (target: 240 min = 4 hours).
   Found by querying seeded rows directly.
3. The 8-week spread collapsed into 2–3 weeks because `resolved_at` was interpolated
   between creation and *now*. Fixed by interpolating within a short window after creation.

---

### Deployment: four failures, none reproducible locally

1. **Render build failed** — `NODE_ENV=production` skipped devDependencies, which include
   TypeScript. Fixed with `--include=dev` on the build install step.
2. **Client routes 404'd on refresh** — Vercel serves static files; only `/` existed.
   Fixed with an `index.html` rewrite.
3. **Double-slash in API URLs** — trailing slash on the base URL produced `//api/...`.
   Fixed with client-side normalization.
4. **iOS Safari discarded the session cookie** — the cookie was third-party (client on
   `vercel.app`, API on `onrender.com`). Desktop Chrome accepted it; iOS Safari blocks
   third-party cookies outright. Rather than move the token to `localStorage` — trading a
   cookie a script can't read for one it can — I proxied `/api/*` through the client's
   own origin. Verified: the rewrite is ordered before the SPA catch-all, and the CSRF
   origin check still passes. (`decisions.md` 15)

   This bug is invisible to the entire test suite: Supertest drives Express in-process
   with no browser and no cookie jar. ~350 tests passed throughout, including every
   authentication test. It was found by opening the deployed app on a phone.
