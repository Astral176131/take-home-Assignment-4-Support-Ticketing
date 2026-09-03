# Decisions

The choices that shaped this codebase, recorded as they were made rather than
reconstructed afterwards. Each one had a real alternative.

---

## 1. Customers are records, not users — and their email is unique

- **Chose:** a `requesters` table holding name and email, with a unique index on the email
  and lowercasing before insert. A ticket links to a requester; find-or-create resolves one
  from the email on the payload.
- **Rejected:** typing the customer's name and email onto each ticket; or making customers
  users of the system with accounts.
- **Why:** a customer who writes twice must have both tickets attached to the same record,
  or "what else has this person raised" cannot be answered. Customers never sign in, hold
  no password and have no role, so making them users would mean a table where most columns
  are meaningless for most rows.

  The unique index was the part worth arguing about, because the brief's schema doesn't
  list one. A test firing two simultaneous ticket creations for the same new customer
  showed that without it both requests insert, producing two records for one person and
  splitting her history — silently, with nothing anywhere indicating a problem. The index
  did not fix the race. It made it **visible**, turning quiet corruption into a loud
  conflict the endpoint catches and recovers from. That trade — fail loudly rather than
  corrupt quietly — is the reasoning, not the index itself.

---

## 2. Resolving the requester happens outside the ticket transaction

- **Chose:** find-or-create the customer first, then open a transaction for the ticket and
  its history rows.
- **Rejected:** doing everything, customer included, in one transaction.
- **Why:** forced by the fix to the race above, and better on its own merits. Postgres
  aborts an entire transaction the moment any statement in it fails — so a request that
  lost the insert race could not recover *from inside* the transaction; every subsequent
  query would fail too. It has to read the winner's row from outside.

  It is also the more honest boundary. A customer record is not part of a ticket's atomic
  state. If the ticket write then fails, what remains is a customer with no tickets, which
  is harmless — as opposed to a ticket with no history, which is not.

---

## 3. Attaching people to a ticket is a supervisor power, everywhere

- **Chose:** an agent may assign a new ticket to themselves or leave it unassigned, and
  cannot add collaborators. A supervisor may assign any agent and add any agents, but never
  themselves or the other supervisor. The creating agent is always attached as a
  collaborator, so they keep access however the ticket ends up assigned.
- **Rejected:** the brief's authorization matrix, which grants collaborator management to
  the assignee and existing collaborators as well as supervisors.
- **Why:** **this is a deliberate deviation from the brief and worth being explicit about.**
  The matrix already forbids an agent from reassigning a ticket "not even to another
  agent". But if that same agent can add a colleague as a collaborator, they can share the
  work sideways anyway — the restriction has a side door. Narrowing collaborator management
  to supervisors makes one rule instead of two: routing work to another person is a
  supervisor's call, at creation, at reassignment and at collaboration alike.

  Supervisors are excluded from both roles because they already have full access to every
  ticket and every action, so a row naming them grants nothing and adds noise to the
  collaborator list on screen. The consequence — supervisors never appear as assignees in
  Phase 5's per-agent breakdown — is intended, with one exception in decision 4.

---

## 4. A supervisor becomes an assignee only by taking over an escalation

- **Chose:** nobody can hand a supervisor a ticket at creation, but a supervisor may
  reassign one to themselves later.
- **Rejected:** supervisors never being assignees at all; or letting them be assigned
  at creation like anyone else.
- **Why:** real desks escalate. An agent gets stuck, and a supervisor takes the ticket
  over. Forbidding that entirely would mean the only way to escalate is informal. Allowing
  it at creation, though, would make "assignee" stop meaning "the agent doing the work" in
  the ordinary case.

  Creation and reassignment therefore differ on purpose: one is routing, the other is
  intervention.

---

## 5. `resolved_at` and `closed_at` are historical markers, not state flags

- **Chose:** reopening a ticket leaves both timestamps in place. They record the last time
  each thing happened. Only `status` says where a ticket is now.
- **Rejected:** clearing them on reopen so that a non-null `closed_at` always means closed.
- **Why:** clearing them destroys information — you could no longer ask when a ticket was
  first resolved. Keeping them costs a discipline instead: **no code may infer state from
  these columns.** Every read keys off `status` first, including the SLA clock, which
  freezes at `resolved_at` only when the status is actually `resolved`. Phase 5's
  "resolved this week" count filters on current status for the same reason.

  This is the decision most likely to be violated later by accident, which is why it is
  written down rather than left implicit.

---

## 6. The SLA clock has an explicit start, and only a reopen from closed restarts it

- **Chose:** a `clock_started_at` column, equal to creation time until a `closed → open`
  reopen resets it along with `paused_minutes`. A `resolved → open` reopen resets nothing.
- **Rejected:** folding the restart into `paused_minutes` by crediting all elapsed time at
  once; deriving the clock start by replaying `ticket_events`; or restarting on both kinds
  of reopen.
- **Why:** three separate calls.

  *Why a column:* overloading `paused_minutes` would make it mean "time excluded from the
  clock" rather than "time spent waiting on the customer" — subtle, and the sort of thing
  that is wrong six months later. Replaying events would force Phase 5's dashboard
  aggregates to scan the event table per ticket instead of computing in plain SQL.

  *Why only `closed → open`:* the brief has that transition, and only that one, increment
  `ack_cycle` — its own signal that a new cycle has begun. `resolved → open` is described
  as undoing a premature resolve, often within minutes. Restarting the clock there would
  make resolve-then-reopen a way to wipe a breach.

---

## 7. The server decides which status moves are legal, and says so in the payload

- **Chose:** every ticket response carries `allowed_transitions`, computed for that user
  and that ticket. The UI renders one button per entry and holds no rules of its own.
- **Rejected:** the frontend carrying its own copy of the state machine to decide which
  buttons to show.
- **Why:** the same rules written twice in two languages drift. Here the list the client
  receives is produced by asking the *same function* the endpoint enforces with — they
  cannot disagree, structurally. An agent never receives `closed`, so no Close button can
  exist for them; when a reopen window lapses the list arrives empty and the button
  disappears without the page knowing why.

  The endpoint still re-checks every request regardless of what the client was told.
  Assume a hostile caller with curl.

---

## 8. Two error codes with different meanings, kept apart

- **Chose:** 400 for a request that does not make sense, 403 for one the caller is not
  allowed to make, 409 for one that conflicts with the ticket's current state. An unknown
  status value is 400; a real status that is an illegal move is 409.
- **Rejected:** using 400 for all rejections.
- **Why:** the brief asks for illegal transitions to be refused "with a specific
  human-readable reason". The status code is half of that reason. "You sent nonsense",
  "you may not do this", and "this ticket is not in a state where that is possible" are
  three different problems for the caller, and only the last one might succeed later.

---

## 9. Warn about duplicate tickets rather than blocking them

- **Chose:** when an agent enters a customer's email on the create form, the system shows
  that customer's open tickets — subject, status and who holds each. Filing anyway is
  allowed.
- **Rejected:** refusing to create a second ticket for the same customer and description.
- **Why:** the system cannot tell a follow-up from a genuinely new problem; only a person
  can. A customer can legitimately have two issues at once, and blocking would sometimes be
  wrong in a way the agent could not override.

  This needed a deliberate exception to the authorization model: the duplicate check
  returns tickets the asking agent cannot otherwise see. Without it the feature would be
  silently useless in exactly the case it exists for — a duplicate of a ticket held by
  *someone else*. The exception is kept as narrow as it can be: subject, status and holder,
  never the description or replies, and opening the ticket itself still returns 403.

- **Later reversed:** blocking was chosen instead. What changed the mind was thinking about
  the scenario the brief opens with — a customer emailing three times about the same issue
  because nobody could tell it was already being handled. A warning still permits exactly
  that outcome, since it relies on a busy agent reading it. The rule agreed is *same
  requester plus same description, against open tickets only*, so a genuine recurrence
  after closure still gets its own ticket.

  **The shipped behaviour is still the warning, deliberately.** Blocking is scheduled for
  after Phase 6, once all ten goals are met — the brief is explicit that finishing fewer
  goals properly beats leaving all ten half-done, and duplicate blocking is not one of the
  ten. The remaining choice is enforcement: a database constraint would be airtight even
  against two agents filing simultaneously but leaves no room for an override, while an
  application check is simpler and overridable but carries the same read-then-write race
  that decision 1 was about.

---

## 10. Access is binary — no read-only tier for people who used to work a ticket

- **Chose:** the moment an agent stops being the assignee or a collaborator, they get a 403
  on that ticket. Reassignment and collaborator removal both revoke access completely, with
  no residual state. The previous assignee is not auto-added as a collaborator; a supervisor
  who wants them to stay involved must add them explicitly.
- **Rejected:** a third permission tier giving former assignees read-only visibility, and a
  "tickets I've handled" view built on it.
- **Why:** the brief scopes access by *current* standing in both places it addresses the
  question — "agents can only act on tickets where they are the primary assignee or a
  collaborator", and the same wording again for the my-tickets list. Nothing asks for
  former workers to retain visibility.

  The need behind the idea — seeing what happened on a ticket you used to own — is already
  met by the immutable timeline, which permanently records every status change,
  reassignment and reply. That is an audit concern, and audit is a supervisor's view, not a
  reason to loosen live ticket access.

  The cost mattered too. Every other deviation in this document *narrows* the brief's
  matrix, which is easy to defend. This one would have widened it, and it would have turned
  a single yes/no question asked by every route into two — splitting `checkTicketAccess`,
  touching every endpoint, and rewriting the 52 matrix tests that assert a boolean per row.

---

## 11. Testing against a real database, in its own Supabase project

- **Chose:** Vitest and Supertest against a second, separate Postgres database. Each test
  file creates the users, tickets and customers it needs, and deletes them afterwards.
- **Rejected:** mocking Prisma; or sharing one database between development and tests.
- **Why:** the rules worth testing here are transactional and constraint-shaped — a status
  change and its history row landing together, a unique index rejecting a duplicate, an
  access rule expressed as a `WHERE` clause. A mocked Prisma would assert that the code
  calls the functions the code calls, and would have caught none of the three real bugs the
  suite has found so far.

  Separate databases because the tests create and delete freely, and because Phase 5 has to
  assert exact dashboard counts against a known dataset — impossible if demo data is
  underfoot.

---

## 12. The alerts list is scoped like acknowledgement, not like the brief's literal wording

- **Chose:** an agent's `GET /api/alerts` includes tickets they collaborate on, not only
  ones they are the primary assignee for — the same scope `POST /:id/alerts/ack` uses.
- **Rejected:** the brief's own wording for the list, "their assigned tickets," read
  literally as assignee-only.
- **Why:** the brief phrases the list more narrowly than it phrases acknowledgement
  ("assigned to them," itself ambiguous, resolved in an earlier decision to include
  collaborators). Keeping the list narrower than ack would produce a real absurdity: a
  collaborator permitted to acknowledge an alert that never appears anywhere in their own
  alerts list. The two only make sense as one scope — what you may act on is what you can
  see needs acting on.

  A second real-world constraint shaped acknowledgement itself: it is only valid against a
  currently active alert (409 otherwise). Every mainstream alert-management tool
  (PagerDuty, Opsgenie, and similar) ties acknowledgement to a concrete, firing instance —
  there is no precedent anywhere for acknowledging a hypothetical future breach, and
  `ack_cycle` already provides the real equivalent of "let me know if this happens again":
  a fresh cycle, and therefore a fresh, un-silenced alert, on every reopen.

---

## Bugs these decisions surfaced

Worth recording, because each one was found by a test rather than in production:

1. **Prisma drops `undefined` filter values** instead of matching nothing. An absent user
   id turned the collaborator lookup in `checkTicketAccess` into "any collaborator" and
   allowed a stranger through. Unreachable over HTTP, since the id comes from a verified
   JWT — but the helper now fails closed.
2. **The requester race** described in decision 1, which returned a 500 to one of two
   simultaneous filings.
3. **The server did not compile.** `tsc` had never been run; Express 5 types a route
   parameter as `string | string[]`, and Phase 1's code assumed a string. Tests never
   caught it because Vitest transpiles without typechecking — and `npm run build` is
   exactly what Render will run at deploy time.
4. **A blanket `router.use(requireRole('supervisor'))` in `bulk.routes.ts` gated every
   route in every router mounted after it** at the same `/api/tickets` prefix, not just its
   own two routes — Express runs a path-less `router.use()` for anything reaching that
   prefix, regardless of which router's own route eventually matches. Invisible for two
   commits because nothing was mounted after it yet; surfaced the moment `ack.routes.ts`
   was added and every agent ack attempt failed with "Insufficient permissions," a message
   that appears nowhere in `ack.routes.ts` itself. Fixed by scoping the role check to each
   route individually, matching the convention every other supervisor-gated router already
   used.
