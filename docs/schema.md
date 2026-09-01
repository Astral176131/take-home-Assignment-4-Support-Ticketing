# Schema

## Tables, columns, and types

### users
| Column | Type | Notes |
|--------|------|-------|
| id | UUID (PK) | Auto-generated |
| email | VARCHAR, UNIQUE | Login identifier |
| password_hash | VARCHAR | bcrypt hash, never returned by API |
| name | VARCHAR | Display name |
| role | ENUM (agent, supervisor) | Determines authorization level |
| created_at | TIMESTAMPTZ | Default now() |

### requesters
| Column | Type | Notes |
|--------|------|-------|
| id | UUID (PK) | Auto-generated |
| name | VARCHAR | Customer name |
| email | VARCHAR | Not unique — same customer could email from different addresses in theory |
| created_at | TIMESTAMPTZ | Default now() |

### priorities
| Column | Type | Notes |
|--------|------|-------|
| code | ENUM PK (low, normal, high, urgent) | Natural key, no surrogate ID needed |
| target_response_minutes | INT | SLA target: low=4320 (3d), normal=1440 (1d), high=240 (4h), urgent=60 (1h) |
| sort_order | INT | For UI ordering |

### tickets
| Column | Type | Notes |
|--------|------|-------|
| id | UUID (PK) | Auto-generated |
| subject | VARCHAR | Searchable (Phase 4) |
| description | TEXT | Searchable (Phase 4) |
| requester_id | UUID (FK → requesters) | Who reported it |
| priority_code | ENUM (FK → priorities) | SLA target lookup |
| category | ENUM (bug, billing, how_to, other) | Plain enum, no lookup table |
| status | ENUM (new_ticket, open, pending, resolved, closed) | Default new_ticket. Uses `new_ticket` because `new` is reserved in some contexts |
| assignee_id | UUID? (FK → users) | Nullable — unassigned tickets are in `new` status |
| pending_since | TIMESTAMPTZ? | Set when entering `pending`, cleared on exit |
| paused_minutes | INT (default 0) | Accumulated time spent in `pending` status |
| resolved_at | TIMESTAMPTZ? | Set on resolution |
| closed_at | TIMESTAMPTZ? | Set on close, used for reopen window check |
| archived_at | TIMESTAMPTZ? | Soft delete — non-null means archived |
| ack_cycle | INT (default 0) | Incremented on reopen (closed→open) |
| acked_through_cycle | INT? | SLA alert is active when < ack_cycle |
| created_at | TIMESTAMPTZ | Default now() |
| updated_at | TIMESTAMPTZ | Auto-updated by Prisma |

**Indexes:** status, assignee_id, archived_at, created_at. Full-text index deferred to Phase 4.

### ticket_collaborators
| Column | Type | Notes |
|--------|------|-------|
| ticket_id | UUID (FK → tickets) | Composite PK |
| agent_id | UUID (FK → users) | Composite PK |
| created_at | TIMESTAMPTZ | Default now() |

**Index:** agent_id (for "my tickets" lookups)

### replies
| Column | Type | Notes |
|--------|------|-------|
| id | UUID (PK) | Auto-generated |
| ticket_id | UUID (FK → tickets) | Which ticket this belongs to |
| author_id | UUID (FK) | Who wrote it |
| author_type | ENUM (agent, customer) | Whether the author is an agent logging it or a customer reply |
| body | TEXT | Reply content |
| is_internal | BOOLEAN (default false) | Internal notes vs customer-visible |
| created_at | TIMESTAMPTZ | Default now() |

**Index:** ticket_id

### ticket_events
| Column | Type | Notes |
|--------|------|-------|
| id | UUID (PK) | Auto-generated |
| ticket_id | UUID (FK → tickets) | Which ticket this event belongs to |
| event_type | ENUM | status_change, reassignment, collaborator_added/removed, archived, restored, reply_added, sla_ack |
| actor_id | UUID? (FK → users) | Who triggered it (nullable for system events) |
| old_value | TEXT? | Previous state (e.g., old status) |
| new_value | TEXT? | New state |
| created_at | TIMESTAMPTZ | Default now() |

**Index:** ticket_id. **No UPDATE or DELETE routes ever** — this is the immutable audit log.

## Relationships

**One-to-many:**
- users → tickets (as assignee): one user can be assigned many tickets
- requesters → tickets: one requester can have many tickets
- priorities → tickets: one priority level applies to many tickets
- tickets → replies: one ticket has many replies
- tickets → ticket_events: one ticket has many events

**Many-to-many:**
- users ↔ tickets (via ticket_collaborators): an agent can collaborate on many tickets, a ticket can have many collaborators

## Constraints: database vs application

**In the database:**
- Primary keys, foreign keys, unique constraints (users.email)
- NOT NULL constraints on required fields
- Default values (status, paused_minutes, ack_cycle, timestamps)
- Enum types for status, role, priority, category, author_type, event_type

**In the application:**
- State machine transitions (which status changes are legal) — too complex for CHECK constraints
- Authorization rules (who can do what) — requires runtime user context
- SLA breach calculation (computed on read, not stored)
- Reopen window check (7-day boundary from closed_at)
- Requirement that assignee_id must be set before transitioning new→open

## Deliberate denormalization

- `paused_minutes` on tickets: accumulated counter instead of computing from event history. Avoids scanning all events on every read. Trade-off: if events are lost or corrupted, this counter drifts — but events are append-only so that shouldn't happen.
- `ack_cycle` and `acked_through_cycle` on tickets: two integers instead of a separate ack table. Simple comparison (`acked_through_cycle < ack_cycle`) determines if alert is active.

## What breaks first at 100x data

1. **Full-text search on tickets (subject + description)** — without a proper GIN/trigram index, LIKE queries will table-scan. Phase 4 will add this index.
2. **Dashboard aggregate queries** — `GROUP BY` across all tickets will slow down. Would need materialized views or a summary table refreshed on a schedule.
3. **ticket_events table** — grows linearly with every action. Would need partitioning by date or archival of old events.
4. **The "my tickets" query** — UNION of assignee OR collaborator requires two index lookups. At scale, a denormalized "agent_tickets" table would help.
