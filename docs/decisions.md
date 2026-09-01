# Decisions

Log the decisions that actually shaped this codebase — the ones where a real alternative existed and
you picked one. At least five entries. For each: what you chose, what you rejected, and why. At least
one entry must be a decision you later reversed — say what changed your mind. It can be any entry
below, not necessarily the last one; add a **Later reversed:** line to whichever one it is.

## Decision 1 — JWT storage: httpOnly cookie vs localStorage

- **Chose:** httpOnly cookie with `secure` (prod) and `sameSite: 'lax'`
- **Rejected:** localStorage
- **Why:** httpOnly cookies are immune to XSS — JavaScript cannot read or exfiltrate the token. localStorage is readable by any script running on the page, which means a single XSS vulnerability leaks every active session. The build prompt mandates this, but even without the mandate, httpOnly is the correct choice for a tool that handles internal support data.

## Decision 2 — Cross-origin cookie strategy: `sameSite: 'lax'` + Vercel proxy vs `sameSite: 'none'`

- **Chose:** `sameSite: 'lax'` with a Vercel rewrite/proxy in production so the API appears to be on the same origin as the frontend
- **Rejected:** `sameSite: 'none'` with `secure: true` for true cross-origin cookies
- **Why:** `sameSite: 'none'` cookies are increasingly restricted by browsers (partitioned storage, third-party cookie blocking). A proxy avoids the entire class of problems — the browser sees one origin, cookies "just work." Also avoids the complexity of configuring CORS with explicit `Access-Control-Allow-Origin` and `credentials: true` across environments.

## Decision 3 — Backend structure: feature folders with inline handlers vs controller/service layers

- **Chose:** Feature-based folders (`features/auth/`, `features/tickets/`) with a single route file per feature and handlers inline. Shared middleware in `middleware/`.
- **Rejected:** Separate controller and service layers per feature (routes → controllers → services → Prisma)
- **Why:** The build prompt explicitly warns against "repository-pattern-over-an-ORM" and "unnecessary abstraction." With Prisma as the ORM, a service layer is a thin pass-through that adds files without adding value. A junior engineer can open `auth.routes.ts` and see the full request→response flow in one file. Three layers × five features = 15 files of indirection for no real benefit at this scale.

## Decision 4 — Prisma schema: `new_ticket` enum value vs `new`

- **Chose:** `new_ticket` as the Prisma enum value for the "new" ticket status
- **Rejected:** Using `new` directly
- **Why:** `new` is a reserved keyword in JavaScript/TypeScript and causes issues in some code generation contexts. Prisma generates typed constants from enum values, and `Status.new` would conflict with constructor syntax. The database column still stores a clean value, and the API maps it for display purposes. This is a pragmatic concession to the tooling.

## Decision 5 — JWT_SECRET validation: fail-fast at startup vs lazy check on first request

- **Chose:** Lazy check via `getJwtSecret()` function called on first auth request
- **Rejected:** Throw at module import time (`const JWT_SECRET = process.env.JWT_SECRET; if (!JWT_SECRET) throw ...`)
- **Why:** Initially implemented the fail-fast approach (Decision 5 was originally "fail at startup"). **Later reversed:** The fail-fast approach crashed on import because the middleware module is loaded before `dotenv.config()` runs in `index.ts`. The import chain is `index.ts → app.ts → auth.routes.ts → middleware/auth.ts`, and by the time the middleware's top-level code runs, `process.env.JWT_SECRET` is still undefined. Switched to a lazy getter that checks on first use, by which point dotenv has loaded.
- **Later reversed:** Yes — the original fail-fast was correct in principle but wrong in execution order. The lazy approach preserves the same safety (first request will fail immediately if the secret is missing) while respecting Node.js module loading order.

## Decision 6 — Environment variable loading: side-effect import vs `dotenv.config()`

- **Chose:** `import 'dotenv/config'` as the very first line in the entry point (`index.ts`).
- **Rejected:** `import dotenv from 'dotenv'; dotenv.config();`
- **Why:** In ES/TypeScript modules, `import` statements are hoisted and evaluated *before* any runtime code execution. By calling `dotenv.config()` imperatively, any dependencies imported further down the file (such as `app.js` → `lib/prisma.ts`) evaluate before the environment variables are loaded. This caused Prisma's Postgres connection pool to initialize with an undefined `DATABASE_URL`, resulting in an `ECONNREFUSED` error as it fell back to querying localhost. The side-effect import `import 'dotenv/config'` executes the `.env` loading *during* the import phase, fixing the initialization order.
