# Support Ticketing — Claude Code build prompt (BUSY Infotech take-home)

This is a hiring take-home, not a toy project. The grading criteria is explicitly about
**judgement and explainability**, not raw feature count: every decision must be something
the person can defend live on a call three weeks from now. Optimize for correctness, clean
architecture, server-side security, and a git history that reads like a real build — never
for cleverness, unnecessary abstraction layers, or a single giant commit.

Paste this whole file into Claude Code as your first message in the repo (the repo already
contains `README.md`, `SUBMISSION.md`, `.gitignore`, and stub files under `docs/` — do not
overwrite those docs stubs blindly, fill them in as you go per the instructions below).

**GitHub repository:** https://github.com/Astral176131/take-home-Assignment-4-Support-Ticketing.git

If this directory isn't already a clone of that repo, clone it first and work inside it
directly — don't scaffold a fresh local repo and lose the existing README/SUBMISSION/docs
stubs. If it's already cloned, confirm `git remote -v` points at this URL before the first
commit. Push to this remote (`origin`, default branch) after each commit, or at minimum at
the end of every phase — a repo that's incrementally committed locally but only pushed once
at the end still fails the "commit incrementally as the work actually happens" requirement,
since GitHub's commit timestamps and history are what the reviewer actually sees.

---

## Non-negotiable ground rules for every phase

1. **Commit after every meaningful step**, not once at the end. Each commit message should
   describe what changed and, where relevant, why. A commit history of one "initial commit"
   containing a finished app is an automatic failure condition for this assignment — treat
   that as a hard constraint, not a suggestion.
2. **Write tests as you build each feature, not after.** Every business rule below has a
   "must test" line — do not skip it.
3. **Update `docs/decisions.md` and `docs/plan.md` incrementally, in the same session as the
   decision, not reconstructed from memory at the end.** If you (Claude Code) make a
   judgment call that isn't fully specified below, stop and say what you're choosing and
   why in your response — the human will either confirm or override it, and either way it
   gets logged as a decision.
4. **No unnecessary abstraction.** No repository-pattern-over-an-ORM, no generic CRUD
   framework, no premature microservices. A junior engineer should be able to open any file
   and understand it without a guide.
5. **Every authorization rule below is enforced in the API layer, never only in the UI.**
   Assume every endpoint will be hit directly with curl by a hostile grader.
6. **Stack:** React + TypeScript (Vite) frontend, Node.js + Express + TypeScript backend,
   PostgreSQL via Prisma ORM, deployed as three separate pieces (Supabase for Postgres,
   Render for the API, Vercel for the frontend). Auth is hand-rolled email+password with
   bcrypt hashing and a JWT stored in an httpOnly, secure, sameSite cookie — not
   localStorage, and not a third-party auth provider. Testing: Vitest + Supertest against a
   real test database (not mocks) for backend logic; keep frontend tests minimal (a few
   React Testing Library smoke tests) since the grading weight is on backend correctness.

---

## Reference: authorization matrix (implement exactly this)

| Action | Supervisor | Assignee/collaborator agent | Other agent |
|---|---|---|---|
| View full queue | yes | no (only "my tickets") | no |
| View one ticket | yes | yes | no |
| Create ticket | yes | yes | — |
| Edit ticket fields | yes | yes | no |
| Reply (public or internal) | yes | yes | no |
| Change status New→Open→Pending→Resolved | yes | yes | no |
| Close (Resolved→Closed) | yes | **no** | no |
| Reopen (Closed→Open, within window) | yes | yes | no |
| Reassign primary assignee | yes, to any agent | **no, not even to another agent** | no |
| Add/remove collaborator | yes | yes | no |
| Archive/restore | yes | yes | no |
| Bulk reassign / bulk close | yes | no | no |
| Acknowledge SLA alert | yes | yes, only if assigned to them | no |

## Reference: ticket state machine (implement exactly this, reject everything else)

States: `new`, `open`, `pending`, `resolved`, `closed`.

| From | To | Trigger | Notes |
|---|---|---|---|
| new | open | manual | requires `assignee_id` to be set — reject with a clear message if null |
| open | pending | manual | sets `pending_since = now()` |
| open | resolved | manual | sets `resolved_at = now()` |
| pending | open | manual OR automatic on a customer reply | on leaving pending: `paused_minutes += now() - pending_since`, clear `pending_since` |
| resolved | open | manual (reopen before close) | |
| resolved | closed | manual, **supervisor only** | sets `closed_at = now()` |
| closed | open | manual, only if `now() - closed_at <= REOPEN_WINDOW_DAYS (7)` | if outside window, reject with "reopen window has expired"; on success, increment `ack_cycle` |
| anything else | — | — | reject with a specific human-readable reason, HTTP 409 |

SLA breach check (compute on read, do not store a "due at" column):
```
elapsed = now() - created_at - paused_minutes - (status == 'pending' ? 0 : 0)
// while status is 'pending' the clock does not advance at all, so if currently pending,
// use paused_minutes as of pending_since (i.e. freeze elapsed at the moment pending began)
breached = elapsed > priority.target_response_minutes
warning  = !breached && (priority.target_response_minutes - elapsed) < WARNING_WINDOW_MINUTES (15)
alert_active = (breached || warning) && acked_through_cycle < ack_cycle
```

## Reference: database schema (Prisma-flavored, adapt syntax as needed)

```
users            (id, email unique, password_hash, name, role enum[agent|supervisor], created_at)
requesters       (id, name, email, created_at)
priorities       (code PK enum[low|normal|high|urgent], target_response_minutes int, sort_order int)
tickets          (id, subject, description, requester_id FK, priority_code FK, category enum,
                  status enum[new|open|pending|resolved|closed] default new,
                  assignee_id FK nullable, pending_since timestamptz nullable,
                  paused_minutes int default 0, resolved_at nullable, closed_at nullable,
                  archived_at nullable, ack_cycle int default 0, acked_through_cycle int nullable,
                  created_at, updated_at)
ticket_collaborators (ticket_id FK, agent_id FK, created_at, PK(ticket_id, agent_id))
replies          (id, ticket_id FK, author_id FK, author_type enum[agent|customer],
                  body text, is_internal bool default false, created_at)
ticket_events    (id, ticket_id FK, event_type enum[status_change|reassignment|
                  collaborator_added|collaborator_removed|archived|restored|reply_added|sla_ack],
                  actor_id FK nullable, old_value text nullable, new_value text nullable, created_at)
```

Indexes to add: `tickets(status)`, `tickets(assignee_id)`, `tickets(archived_at)`,
`tickets(created_at)`, a trigram or full-text index on `tickets(subject, description)` for
Goal 6's search, `ticket_collaborators(agent_id)`, `replies(ticket_id)`, `ticket_events(ticket_id)`.

`ticket_events` gets no UPDATE/DELETE route in the API, ever — not even for supervisors.

Category and priority target numbers (placeholders — fine to keep, just document them):
`low=4320min(3d), normal=1440min(1d), high=240min(4h), urgent=60min(1h)`.
Categories: `bug, billing, how_to, other` (plain enum — no extra attributes, so no lookup table needed).

---

## Phase 1 — Foundation (auth + schema + skeleton)

- Set up two projects: `/server` (Express + TypeScript + Prisma) and `/client` (Vite + React + TypeScript).
- Write the Prisma schema exactly as above, run the first migration.
- Implement signup-free auth: a seed script creates demo users (at least 2 supervisors, 4+
  agents) — there is no self-registration UI, since the brief never asks for one.
- `POST /api/auth/login` (email+password → sets httpOnly JWT cookie), `POST
  /api/auth/logout`, `GET /api/auth/me`.
- Auth middleware that attaches `req.user` and rejects missing/invalid tokens with 401.
- A role-check helper (`requireRole('supervisor')`) and a ticket-access helper
  (`requireTicketAccess(ticket, user)`) that both future phases reuse — this is the one
  piece of shared "infrastructure" that's justified, since the authorization matrix above
  applies to almost every route.
- Minimal React shell: login page, a protected layout, logout button. No ticket UI yet.
- **Tests:** login succeeds/fails correctly, protected route rejects no-cookie and expired
  JWT, `requireRole` and `requireTicketAccess` unit tests covering every row of the
  authorization matrix in isolation (these are cheap to test now and reused everywhere).
- **Commit checkpoints:** (a) Prisma schema + migration, (b) auth endpoints + middleware +
  tests, (c) minimal frontend shell wired to auth. At least 3 commits, not 1.
- **Docs:** start `docs/architecture.md` (moving pieces, where each runs) and
  `docs/schema.md` (table-by-table) now, while it's fresh — don't wait until the end.

## Phase 2 — Core ticket lifecycle (Goals 2, 3, 4)

- `POST /api/tickets`, `GET /api/tickets/:id`, `PATCH /api/tickets/:id` (edit fields),
  `POST /api/tickets/:id/archive`, `POST /api/tickets/:id/restore`.
- `POST /api/tickets/:id/replies` (body, is_internal, author_type) — author_type='customer'
  is how an agent logs an incoming customer email; if a customer reply is logged while
  status is `pending`, auto-transition to `open` per the state machine table above.
- `POST /api/tickets/:id/status` implementing the exact state machine table above — reject
  anything not in the table with a 409 and a specific message.
- Every status change and reassignment writes a `ticket_events` row inside the same DB
  transaction as the state change (never allow a state change to succeed without its audit row).
- Basic ticket detail page in React: fields, reply list (chronological), status buttons
  that only show transitions currently legal for this user+ticket (still re-check
  server-side regardless).
- **Tests:** every edge of the state machine table (both legal and illegal transitions,
  including the reopen-window boundary just inside/outside 7 days), the pending-clock pause
  math with a mid-ticket pending interval, archived tickets excluded from default list but
  still fully readable, internal notes never returned to a "customer view" filter (if you
  build one) or at minimum are clearly flagged in the payload.
- **Commit checkpoints:** ticket CRUD, then replies, then the state machine + events
  together (they're one atomic feature, don't split them).

## Phase 3 — Collaboration & authorization hardening (Goals 1, 5)

- `POST /api/tickets/:id/collaborators`, `DELETE /api/tickets/:id/collaborators/:agentId`.
- `GET /api/tickets/mine` — union of assignee-or-collaborator for the current agent.
- Go back through every route from Phases 1–2 and add an explicit authorization test that
  proves the *disallowed* actor gets a 403 — not just that the allowed actor succeeds. This
  is the single most graded thing in the brief ("must be enforced on the server"), so don't
  treat it as done until there's a failing-case test for every row of the matrix.
- Reassign endpoint (`POST /api/tickets/:id/reassign`) — supervisor only, verify an agent
  cannot hit this on their own ticket and get anything but 403.
- **Tests:** collaborator can reply/update but not reassign or close; removing a
  collaborator revokes access on the very next request; agent reassign attempt → 403 in
  all cases, including reassigning "to themselves."
- **Commit checkpoints:** collaborators feature, then a dedicated "authorization hardening"
  commit (or a few) that's mostly tests — this is a legitimate, explainable commit on its
  own, and worth having in the history.

## Phase 4 — Queue, search, bulk actions, export (Goals 6, 7)

- `GET /api/tickets` with query params: `q` (search subject+description), `status`,
  `priority`, `category`, `assignee_id`, `sort` (created_at|priority|updated_at), `page`,
  `page_size`. Response includes `{ items, total }`. Enforce a max page size server-side.
- `POST /api/tickets/bulk-reassign`, `POST /api/tickets/bulk-close` — both supervisor-only,
  both return a per-ticket `{ ticket_id, success, reason? }[]`, never an all-or-nothing
  failure. Each ticket's update + event write happens in its own transaction so one
  failure can't roll back another ticket's success.
- `GET /api/tickets/export.csv` — same filters as the list endpoint, streams CSV.
- Queue UI: table with search box, filter dropdowns, sortable columns, pagination
  controls, checkboxes + a bulk-action bar, an "export CSV" button.
- **Tests:** search matches partial words; filters AND together correctly; total count
  matches under pagination; a bulk request mixing valid and invalid ticket IDs returns 200
  with a mixed report, never a blanket 400; exported CSV row count matches the filtered
  total.
- **Commit checkpoints:** search/filter/sort/paginate first (it's the foundation for
  export), then bulk actions, then export.

## Phase 5 — Dashboard & SLA alerts (Goals 8, 10)

- `GET /api/dashboard` returning: open count, pending count, resolved-this-week count,
  breaching count, counts by status, counts by agent, resolved-per-week for the last 8
  weeks — all via `GROUP BY` aggregate queries, not application-level counting.
- `GET /api/alerts` — tickets where `alert_active` per the formula above, for the current
  user (their assigned tickets) or all tickets if supervisor.
- `POST /api/tickets/:id/alerts/ack` — sets `acked_through_cycle = ack_cycle`, only if the
  ticket is assigned to the caller (or caller is supervisor — confirm/override this in
  `decisions.md`, the brief says "assigned to them" which is ambiguous about supervisors).
- Confirm `ack_cycle` increments exactly on `closed → open` transitions (the one place a
  ticket's SLA clock meaningfully restarts) — write this as an explicit test, it's the
  easiest rule in the whole brief to get subtly wrong.
- Dashboard page with headline numbers, a status/agent breakdown, and an 8-week chart.
  Nav bar shows a live alert-count badge.
- **Tests:** dashboard counts match a known seeded dataset exactly; alert appears/disappears
  around the breach threshold; ack clears it; **reopen a previously-breached-and-acked
  ticket, let it breach again, confirm the alert returns** — this is the rule most
  candidates get wrong, do not skip this specific test.
- **Commit checkpoints:** dashboard aggregates, then alerts+ack as its own commit (the
  ack-cycle logic deserves to be reviewable in isolation).

## Phase 6 — Seed data, deploy, docs, polish (Goal 9 wrap-up + submission)

- If not already done: confirm `ticket_events` has no update/delete route anywhere, and
  consider revoking UPDATE/DELETE grants on that table at the DB level for defense in depth
  (a good, cheap interview point — "even a compromised API key with a bug can't rewrite
  history").
- Seed script: enough realistic demo data to show the system doing something — at least
  ~40-60 tickets across all statuses/priorities/categories, some archived, some breaching
  SLA, some with collaborators, some with a full reply thread, spread across multiple
  agents and both supervisors. Not an empty shell.
- Deploy: Supabase (Postgres) first, get the connection string into Render's environment
  variables, deploy `/server` to Render, then point `/client`'s API base URL at Render's
  public URL and deploy to Vercel. All secrets in environment variables, never committed —
  double check `.gitignore` is doing its job.
- Fill in `SUBMISSION.md` for real: live URL, GitHub URL, demo credentials for at least one
  supervisor and one agent, a note if the host sleeps on free tier, the goal checklist
  marked honestly (partial is fine, say what's partial), actual time spent, what you'd do
  next, what you're least happy with.
- Finish `docs/architecture.md`, `docs/schema.md`, `docs/plan.md` fully (don't leave any
  template question unanswered).
- Write `docs/decisions.md` — at least 5 real decisions, including the ones already flagged
  during this build (nullable assignee, paused_minutes as a counter, ack_cycle as two ints,
  supervisor-only close, customer-reply-via-agent), and mark whichever one got reversed
  along the way with a **Later reversed:** line.
- Write `docs/ai-prompts.md` — the actual prompts used in this session (this file's phases
  count), grouped by what you were trying to achieve, including at least one that produced
  something wrong and what you changed. Don't reconstruct this from memory — keep it
  updated as you go through phases 1–6.
- **Commit checkpoints:** seed script, deployment config, then docs — docs deserve their
  own final commit(s), don't fold them silently into a code commit.

---

## How to use this file across sessions

Paste the whole file once at the start. Then, at the start of each new session/phase, tell
Claude Code which phase you're resuming (e.g. "Continue with Phase 3 — collaboration and
authorization hardening") so it doesn't try to redo earlier phases or lose the plan across
a context reset. After each phase, ask it to summarize what it built, what it deviated from
in this spec (and why), and draft the relevant `docs/decisions.md` entries before moving on
— that draft is what goes into the real file.
