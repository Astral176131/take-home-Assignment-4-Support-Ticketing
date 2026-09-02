# Schema

Postgres, defined in `server/prisma/schema.prisma` and applied through four migrations.
Column names are `snake_case` in the database; Prisma maps them to `camelCase` in code,
and the API speaks `snake_case` again to match the vocabulary the brief uses.

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
The customers. **Deliberately not users** — they never sign in, hold no password, and have
no role. They are identified by email alone.

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
| `sort_order` | int | for ordering by severity rather than alphabetically |

It is a table rather than a constant because the target times are data an operations
person might reasonably change without a deploy. Category, by contrast, is a bare enum:
`bug`, `billing`, `how_to`, `other` carry no attributes, so a lookup table would be four
rows of nothing but their own names.

### `tickets`
The centre of the system.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `subject`, `description` | text | |
| `requester_id` | uuid, FK → `requesters` | |
| `priority_code` | enum, FK → `priorities` | |
| `category` | enum | |
| `status` | enum, default `new_ticket` | see the naming note below |
| `assignee_id` | uuid, FK → `users`, **nullable** | unassigned is a real state |
| `pending_since` | timestamptz, nullable | set on entering `pending` |
| `paused_minutes` | int, default 0 | total time excluded from the SLA clock |
| `clock_started_at` | timestamptz, default now | **not in the brief's schema**; see below |
| `resolved_at`, `closed_at` | timestamptz, nullable | historical markers, not state flags |
| `archived_at` | timestamptz, nullable | non-null means archived |
| `ack_cycle` | int, default 0 | increments only on `closed → open` |
| `acked_through_cycle` | int, nullable | null means never acknowledged |
| `created_at`, `updated_at` | timestamptz | |

Indexed on `status`, `assignee_id`, `archived_at`, `created_at` — the four columns the
queue filters and sorts by.

Three columns deserve their reasoning stated:

- **`status` stores `new_ticket`, not `new`.** `new` is awkward as an enum member across
  the toolchain. The rename is contained: the API translates in one place and speaks
  `new`, exactly as the brief's state machine does.
- **`clock_started_at` is an addition.** The SLA clock restarts when a closed ticket is
  reopened, so it can no longer be assumed to start at `created_at`. The alternatives were
  overloading `paused_minutes` to mean "time excluded" rather than "time spent pending",
  or replaying the event history per ticket. An explicit column keeps Phase 4's filters and
  Phase 5's aggregates as plain SQL.
- **`resolved_at` and `closed_at` survive a reopen.** They record the last time each
  happened, so nothing may infer "this ticket is closed" from `closed_at` being set. Only
  `status` decides that, and every piece of code that reads them keys off `status` first.

### `ticket_collaborators`
The join table making a ticket's helpers a many-to-many relationship.

| Column | Type |
|---|---|
| `ticket_id`, `agent_id` | uuid, composite PK, both FKs |
| `created_at` | timestamptz |

The composite primary key means the same agent cannot be added twice — the database
enforces it, so no application check can be forgotten. Indexed on `agent_id` for
"every ticket I'm on".

### `replies`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `ticket_id` | uuid, FK → `tickets` | indexed |
| `author_id` | uuid, FK → `users` | the user who **recorded** the reply |
| `author_type` | enum `agent` \| `customer` | whose **words** they are |
| `body` | text | |
| `is_internal` | bool, default false | |
| `created_at` | timestamptz | |

The split between `author_id` and `author_type` is the interesting part. A customer email
is transcribed by an agent, so the author is that agent while the author type is
`customer`. Customers are not users and cannot be pointed at by a foreign key.

The FK on `author_id` was missing from the initial migration and added later, with
`ON DELETE RESTRICT`: a user who has written replies cannot be deleted, because removing
their words would be rewriting history.

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

**There is no update or delete route for this table anywhere in the API, and there never
will be — not even for supervisors.** Every row is written inside the same transaction as
the change it records, through the single `writeEvent` helper, so a ticket cannot change
without leaving a trace.

`old_value` and `new_value` are loose text on purpose: one column pair has to hold a
status name, a user id and a reply id depending on the event type. The alternative was
several mostly-null typed columns.

## One-to-many versus many-to-many

**One-to-many**
- a requester has many tickets *(this is why requesters are their own table rather than a
  name and email typed onto each ticket — it keeps a customer's history in one place)*
- a priority has many tickets
- a user has many assigned tickets, many authored replies, many events they caused
- a ticket has many replies and many events

**Many-to-many**
- tickets and agents, through `ticket_collaborators` — a ticket has any number of
  collaborators, an agent collaborates on any number of tickets

The primary assignee is a plain nullable FK rather than a row in the join table. A ticket
has exactly one, or none, and that is a different shape of fact from "these people are
also involved".

## Database constraints versus application rules

**The database enforces** what must hold regardless of which code path wrote the row:

- foreign keys — every ticket points at a real requester, every reply at a real user
- uniqueness — one user per email, one requester per email, one collaborator row per pair
- enum membership — no ticket can hold a status outside the five
- non-null — a ticket always has a subject, a description, a requester and a priority

**The application enforces** everything that depends on *who is asking* or *where the
ticket has been*: the authorization matrix, the state machine, the reopen window, the
supervisor-only close, the SLA arithmetic.

The line sits at whether a rule is a property of the data or a property of a request. "A
ticket's assignee must exist" is true of any row, at any time, and belongs to the database.
"Only a supervisor may close this" is meaningless without a request attached — the
database has no idea who is asking, and encoding it in a trigger would scatter the
authorization model across two languages.

The one case that argued for itself is worth recording. `requesters.email` originally had
no unique constraint, and find-or-create was pure application code. A test firing two
simultaneous ticket creations for the same new customer proved that both requests could
insert, producing two records for one person and splitting her history in half — silently.
Adding the unique index did not fix the race; it made it *visible*, converting a quiet data
corruption into a loud conflict the endpoint now catches and recovers from.

## Deliberate denormalisation

Very little, and none of it structural.

- **`paused_minutes` is a running total**, not derived by summing pending intervals from
  the event history. The clock has to be computed on every ticket in every list and
  dashboard query; replaying history per ticket to answer "is this breaching" would be
  slow and hard to express in SQL. The event rows still record each transition, so the
  total remains auditable.
- **`clock_started_at` is stored** rather than derived from the most recent reopen event,
  for the same reason.
- **`ack_cycle` / `acked_through_cycle` are two plain integers** rather than a table of
  acknowledgements. Comparing two counters answers "is this alert live" in one expression,
  and reopening a ticket re-arms every alert by incrementing one of them.

Nothing is copied. There is no denormalised assignee name or requester email on the ticket
row; those are joins.

## What breaks first at 100× the data

Roughly 6,000 tickets and 30,000 replies, at 100× a small team's year.

**The list endpoint, first and worst.** It currently returns every matching ticket with no
limit. At 60 tickets that is fine; at 6,000 it is a slow query, a large JSON payload and a
browser rendering thousands of rows. Phase 4 adds pagination with a server-enforced maximum
page size, which is the fix.

**SLA computation in application code, second.** Every row in a list has its breach status
computed in Node after the rows arrive. That is linear in the result set and invisible to
Postgres, so it cannot be used to *filter* — "show me only breaching tickets" would mean
fetching everything and discarding most of it. At scale this wants to become a SQL
expression over `clock_started_at` and `paused_minutes`, which is precisely why the clock's
start is a column rather than something replayed from events.

**Search, third.** Phase 4's text search over subject and description will need a trigram
or full-text index; a `LIKE '%…%'` scan over 6,000 rows of text degrades quickly.

**The ticket detail page, later and more gently.** It loads every reply and every event for
a ticket in one go. A ticket with 500 replies would be unpleasant; both are indexed on
`ticket_id`, so the query stays fast, but the payload does not. Paginating the activity
feed would be the answer.

**What would not break:** the authorization queries. Access scoping is expressed as a
`WHERE` clause over indexed columns and resolved by Postgres, not by fetching tickets and
filtering them in Node — so an agent's queue costs the same to compute whether the system
holds sixty tickets or sixty thousand.
