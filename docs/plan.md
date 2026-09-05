# Plan

## How I split the work

Six phases, each meant to be roughly one sitting, ordered so that every phase could only depend
on things that already worked: database → auth → tickets → collaboration → queue → dashboard →
deploy. Nothing was built against an interface that didn't exist yet.

That ordering was the plan's main deliberate choice, and it held. The alternative — building
the UI in parallel with the API against an agreed contract — would have been faster on paper
and would have meant discovering every disagreement about that contract at integration time,
alone, near the deadline.

## Estimated versus actual

Actual times below are read off commit timestamps, not tracked with a timer, so they measure
the window a session spanned rather than fingers-on-keyboard. Total across the project:
**roughly 15–18 hours** against a 12-hour guide.

| Phase | Focus | Estimated | Actual | What moved it |
|---|---|---|---|---|
| 1 | Scaffold, schema, auth, frontend shell | 2.5h | ~4h, over three sittings on 1 Sep | Prisma 7 released mid-build and moved `datasource.url` out of `schema.prisma` into a new config file, plus required a driver adapter. Then two separate module-hoisting bugs where `import` ran before `dotenv.config()`. |
| 2 | Ticket CRUD, replies, state machine, queue page | 2.5h | ~4h, split across 2–3 Sep | Under-estimated. The state machine and SLA clock are the two hardest pieces of logic in the project and they both live here. |
| 3 | Collaborators, authorization hardening | 1.5h | ~1.5h | The one phase that landed on estimate. Most of it was the authorization matrix test file, which was mechanical once the shape was decided. |
| 4 | Search, filters, sort, pagination, bulk actions, CSV | 2h | ~2h | Also close. Sharing one query builder between the list and the CSV export saved more time than it cost. |
| 5 | Dashboard and SLA alerts | 2h | ~1h | Faster than expected — the aggregates are mostly `GROUP BY`, and the alerts list reuses the same in-progress set the dashboard's breaching count already needed. |
| 6 | Seed data, deployment, docs | 1.5h | ~6h, over two days | The overrun. Detailed below. |

## Where the overrun actually went

**Deployment, not features.** Building against localhost hid every problem that only exists once
three hosts have to agree:

- Render's build failed because setting `NODE_ENV=production` makes npm skip `devDependencies` —
  which is where TypeScript and every `@types/*` package live, so the compile step had nothing to
  compile with.
- Every client route 404'd on refresh until Vercel was told to serve `index.html` for unmatched
  paths. Only `/` worked, because only `/` is a real file.
- The API base URL was set with a trailing slash, producing `//api/...`, which Express does not
  match — a 404 that looked like a broken deployment.
- Then the real one: the session cookie was third-party across two domains. Desktop Chrome kept
  it. iOS Safari discarded it, so sign-in appeared to work and every following request came back
  unauthenticated. Fixed by proxying `/api/*` through the client's own origin (`decisions.md` 15).

**A UI rebuild I didn't plan.** The first pass was functional and unpleasant — it worked, and I
wouldn't have wanted to use it for a day. Rebuilding it in the final session cost hours that
were not in any estimate, and the acknowledgement behaviour changed at the same time: silencing
an alert for a whole response cycle turned out to mean "acknowledge" was a way to make a breach
disappear without fixing it, so it became a 60-minute snooze.

**Test infrastructure, twice.** Running the suite in parallel against a hosted Postgres
exhausted its connection limit, which surfaced as unrelated-looking failures across files. Fixed
by capping each file's pool and disabling file parallelism — correct, but it is why a full server
run now takes about seventeen minutes.

## What I built beyond the ten goals

Only after the ten were done, and each because using the app made the gap obvious rather than
because it sounded good:

- Human-readable ticket keys (`SUP-14`) — a UUID cannot be read aloud or scanned in a CSV.
- A supervisor-only view of unassigned tickets, with a live count badge. Nothing else surfaced
  "nobody has picked this up," which is the failure the brief's scenario opens with.
- Clicking a week on the dashboard's 8-week chart to drill into that week, day by day and by
  agent, in place.
- A personal row on the dashboard — your own open, pending, resolved and breaching counts —
  because the shared numbers answer "how is the queue" and not "what do I owe".
- Per-IP and per-email login throttling.
- Session-expiry handling, after the cookie bug produced an app that rendered its own navigation
  over a wall of 401s with no way out.

## What I cut

**Duplicate blocking.** `decisions.md` 9 records reversing this decision — a warning relies on a
busy agent reading it, which is exactly the failure the brief's scenario describes. It was then
deliberately not shipped, because it is not one of the ten goals and the brief is explicit that
finishing fewer goals properly beats leaving all ten half-done. The reversal is documented and
the code still warns. That gap is intentional and recorded rather than hidden.

**Moving the SLA clock into SQL.** Known from the session it was written, documented in
`schema.md` at the time, and left alone. It is the first thing I would do next.

**All stretch goals.** Canned responses, satisfaction ratings, a status page, tagging, a
knowledge base, auto-routing, merging duplicates, email digests — none attempted. The brief is
explicit that they never substitute for a goal, and the time went to deployment and the rebuild
instead.

**Nothing was cut from the ten goals themselves.** All ten are complete, with two documented
deviations where I disagreed with the brief's own authorization matrix (`decisions.md` 3 and 12).

## What I would change about the plan itself

Deploy at the end of Phase 1, not Phase 6. Every deployment problem above was discoverable on
day one with a hello-world API and an empty client — the cookie problem especially, which is a
property of the hosting topology and has nothing to do with how much of the app exists. Deferring
it concentrated a whole category of unknown risk into the last two days, which is the opposite
of what phase ordering was supposed to achieve everywhere else.
