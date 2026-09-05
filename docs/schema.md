# Schema

Postgres, defined in `server/prisma/schema.prisma` and applied through eight migrations.
Column names are `snake_case` in the database; Prisma maps them to `camelCase` in code, and the
API speaks `snake_case` again to match the vocabulary the brief uses.

## Migrations, in order

| Migration | What it added and why |
|---|---|
| `init` | Every table and enum. |
| `requester_email_unique` | A unique index on `requesters.email`, after a test proved two simultaneous ticket creations for one new customer could split her history across two rows. |
| `reply_author_fk` | The missing foreign key on `replies.author_id`, `ON DELETE RESTRICT` — a user who has written replies cannot be deleted, because removing their words would rewrite history. |
| `ticket_clock_started_at` | An explicit SLA clock start, needed once reopening a closed ticket had to restart it. |
| `ticket_number` | An auto-incrementing integer behind the human-readable key `SUP-14`. |
| `ticket_search_trgm` | `pg_trgm` plus GIN indexes on `subject` and `description`. |
| `ticket_events_immutable` | The trigger that makes the timeline append-only. |
| `ticket_acked_at` | When the current acknowledgement was made, after acknowledging became a timed snooze rather than silence for a whole cycle. |

## Table by table

### `users`
Agents and supervisors. There is no self-registration; rows come from the seed script.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `email` | text, **unique** | how you sign in |
| `password_hash` | text | bcrypt, cost 10 |
| `name` | text | |
| `role` | enum `agent` \| `supervisor` | the whole authorization model turns on this |
| `created_at` | timestamptz | |

### `requesters`
The customers. **Deliberately not users** — they never sign in, hold no password, and have no
role. They are identified by email alone.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `name` | text | |
| `email` | text, **unique** | added in a later migration; lowercased before insert |
| `created_at` | timestamptz | |

### `priorities`
A four-row lookup table, keyed by the priority itself rather than a surrogate id.

| Column | Type | Notes |
|---|---|---|
| `code` | enum `low` \| `normal` \| `high` \| `urgent`, PK | |
| `target_response_minutes` | int | low 4320, normal 1440, high 240, urgent 60 |
| `sort_order` | int | so "sort by priority" orders by severity, not alphabetically |

A table rather than a constant because target times are data an operations person might change
without a deploy. Category, by contrast, is a bare enum: `bug`, `billing`, `how_to`, `other`
carry no attributes, so a lookup table would be four rows of nothing but their own names.

### `tickets`
The centre of the system.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `number` | int, **unique**, autoincrement | display only — the key `SUP-14` is built from it |
| `subject`, `description` | text | both trigram-indexed for search |
| `requester_id` | uuid, FK → `requesters` | |
| `priority_code` | enum, FK → `priorities` | |
| `category` | enum | |
| `status` | enum, default `new_ticket` | see the naming note below |
| `assignee_id` | uuid, FK → `users`, **nullable** | unassigned is a real state, and has its own view |
| `pending_since` | timestamptz, nullable | set on entering `pending` |
| `paused_minutes` | int, default 0 | total time excluded from the SLA clock |
| `clock_started_at` | timestamptz, default now | **not in the brief's schema**; see below |
| `resolved_at`, `closed_at` | timestamptz, nullable | historical markers, not state flags |
| `archived_at` | timestamptz, nullable | non-null means archived |
| `ack_cycle` | int, default 0 | increments only on `closed → open` |
| `acked_through_cycle` | int, nullable | which cycle the last acknowledgement belonged to |
| `acked_at` | timestamptz, nullable | when it was made; null reads as "the snooze has expired" |
| `created_at`, `updated_at` | timestamptz | |

Indexed on `status`, `assignee_id`, `archived_at`, `created_at` — the four columns the queue
filters and sorts by — plus GIN trigram indexes on `subject` and `description`.

Four columns deserve their reasoning stated:

- **`status` stores `new_ticket`, not `new`.** `new` is awkward as an enum member across the
  toolchain. The rename is contained: the API translates in one place and speaks `new`, exactly
  as the brief's state machine does.
- **`clock_started_at` is an addition.** The SLA clock restarts when a closed ticket is
  reopened, so it can no longer be assumed to start at `created_at`. The alternatives were
  overloading `paused_minutes` to mean "time excluded" rather than "time spent pending", or
  replaying the event history per ticket. An explicit column keeps queue filters and dashboard
  aggregates expressible as plain SQL — and is the seam along which the clock could later move
  into the database entirely.
- **`resolved_at` and `closed_at` survive a reopen.** They record the last time each happened,
  so nothing may infer "this ticket is closed" from `closed_at` being set. Only `status` decides
  that, and every piece of code that reads them keys off `status` first.
- **`number` is display-only.** The uuid `id` remains the real primary key in every foreign key,
  route and query. `number` exists because a UUID cannot be read aloud on a call or scanned in a
  spreadsheet column.

### `ticket_collaborators`
The join table making a ticket's helpers a many-to-many relationship.

| Column | Type |
|---|---|
| `ticket_id`, `agent_id` | uuid, composite PK, both FKs |
| `created_at` | timestamptz |

The composite primary key means the same agent cannot be added twice — the database enforces it,
so no application check can be forgotten. Indexed on `agent_id` for "every ticket I'm on".

### `replies`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `ticket_id` | uuid, FK → `tickets` | indexed |
| `author_id` | uuid, FK → `users`, `ON DELETE RESTRICT` | the user who **recorded** the reply |
| `author_type` | enum `agent` \| `customer` | whose **words** they are |
| `body` | text | |
| `is_internal` | bool, default false | |
| `created_at` | timestamptz | |

The split between `author_id` and `author_type` is the interesting part. A customer email is
transcribed by an agent, so the author is that agent while the author type is `customer`.
Customers are not users and cannot be pointed at by a foreign key.

### `ticket_events`
The append-only timeline.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `ticket_id` | uuid, FK → `tickets` | indexed |
| `event_type` | enum | `status_change`, `reassignment`, `collaborator_added`, `collaborator_removed`, `archived`, `restored`, `reply_added`, `sla_ack` |
| `actor_id` | uuid, FK → `users`, nullable | who did it |
| `old_value`, `new_value` | text, nullable | statuses for a status change, a user id for the people-related types, a reply id for `reply_added` |
| `created_at` | timestamptz | |

**There is no update or delete route for this table anywhere in the API, and a database trigger
makes sure that isn't the only thing protecting it.** Every row is written inside the same
transaction as the change it records, through the single `writeEvent` helper, so a ticket cannot
change without leaving a trace.

`old_value` and `new_value` are loose text on purpose: one column pair has to hold a status
name, a user id and a reply id depending on the event type. The alternative was several
mostly-null typed columns.

## One-to-many versus many-to-many

**One-to-many**
- a requester has many tickets *(this is why requesters are their own table rather than a name
  and email typed onto each ticket — it keeps a customer's history in one place)*
- a priority has many tickets
- a user has many assigned tickets, many authored replies, many events they caused
- a ticket has many replies and many events

**Many-to-many**
- tickets and agents, through `ticket_collaborators` — a ticket has any number of collaborators,
  an agent collaborates on any number of tickets

The primary assignee is a plain nullable FK rather than a row in the join table. A ticket has
exactly one, or none, and that is a different shape of fact from "these people are also
involved".

## Database constraints versus application rules

**The database enforces** what must hold regardless of which code path wrote the row:

- foreign keys — every ticket points at a real requester, every reply at a real user
- uniqueness — one user per email, one requester per email, one collaborator row per pair, one
  ticket per number
- enum membership — no ticket can hold a status outside the five
- non-null — a ticket always has a subject, a description, a requester and a priority
- **immutability of `ticket_events`** — a `BEFORE UPDATE OR DELETE` trigger raises
  unconditionally

**The application enforces** everything that depends on *who is asking* or *where the ticket has
been*: the authorization matrix, the state machine, the reopen window, the supervisor-only
close, the SLA arithmetic.

The line sits at whether a rule is a property of the data or a property of a request. "A
ticket's assignee must exist" is true of any row at any time and belongs to the database. "Only
a supervisor may close this" is meaningless without a request attached — the database has no
idea who is asking, and encoding it in a trigger would scatter the authorization model across
two languages.

Two cases argued themselves onto the database side:

**`requesters.email` originally had no unique constraint**, and find-or-create was pure
application code. A test firing two simultaneous ticket creations for the same new customer
proved both requests could insert, splitting one person's history in half — silently. The unique
index did not fix the race. It made it *visible*, converting quiet corruption into a loud
conflict the endpoint now catches and recovers from.

**`ticket_events` immutability could not live in the application at all.** The brief asks that
history be unrewritable even by a supervisor, and "there is no route for it" is a weak guarantee
— it holds only until someone adds one. The build prompt suggested revoking `UPDATE`/`DELETE`
grants; checking first showed the application's role *owns* the table (`current_user =
tableowner`, confirmed by query on both databases), and a Postgres owner's privileges are
inherent — `REVOKE` can only remove separately-granted privileges, never ownership itself. The
revoke would have been a silent no-op. A trigger has no such exception.

## Deliberate denormalisation

Very little, and none of it structural.

- **`paused_minutes` is a running total**, not derived by summing pending intervals from the
  event history. The clock is computed for every ticket in every list and dashboard query;
  replaying history per ticket to answer "is this breaching" would be slow and hard to express
  in SQL. The event rows still record each transition, so the total stays auditable.
- **`clock_started_at` is stored** rather than derived from the most recent reopen event, for
  the same reason.
- **`ack_cycle`, `acked_through_cycle` and `acked_at` are plain columns** rather than a table of
  acknowledgements. Comparing them answers "is this alert live" in one expression. This is also
  the schema's weakest point: it carries three columns where the current behaviour needs two.
  The cycle pair dates from when acknowledging silenced an alert for a whole response cycle;
  `acked_at` arrived when that became a 60-minute snooze, and the pair was kept because a reopen
  still has to re-arm an alert immediately rather than waiting out a snooze. Defensible, but it
  is one column of history rather than design.

Nothing is copied. There is no denormalised assignee name or requester email on the ticket row;
those are joins.

## What breaks first at 100× the data

Roughly 6,000 tickets and 30,000 replies — 100× a small team's year.

**SLA computation in application code, first and worst.** `computeSla()` runs in Node over rows
Postgres has already returned, so the database has no idea what "breaching" means. Filtering the
queue to breaching tickets therefore reads the entire in-progress set and discards most of it,
and the dashboard's breaching count does the same. At sixty tickets this is free; at six
thousand it is a full scan on the most-loaded page in the app. The fix is a stored `breach_at`
timestamp maintained by the same function and indexed, turning it into `WHERE breach_at < now()`
— which is precisely why `clock_started_at` is a column rather than something replayed from
events. This is the known limitation the rest of the design routes around, and the first thing
that would change with more time.

**The ticket detail page, second and more gently.** It loads every reply and every event for a
ticket in one go. Both are indexed on `ticket_id`, so the query stays fast, but the payload does
not. A ticket with 500 replies would be unpleasant; paginating the activity feed is the answer.

**The CSV export, third.** It streams row by row rather than buffering, so memory stays flat —
but a 6,000-row export against a free-tier database will take long enough that it wants a
background job and a download link rather than a synchronous response.

**What would not break:**

- *Search.* `ILIKE '%term%'` over 6,000 rows would degrade badly on its own, which is why the
  trigram GIN indexes exist. Postgres uses them for exactly this pattern.
- *Pagination.* Page size is clamped server-side at 100, so no client can demand an unbounded
  page.
- *The authorization queries.* Access scoping is a `WHERE` clause over indexed columns, resolved
  by Postgres rather than by fetching tickets and filtering in Node — so an agent's queue costs
  the same whether the system holds sixty tickets or sixty thousand.
