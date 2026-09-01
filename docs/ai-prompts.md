# AI prompts

I used AI (Antigravity IDE / Claude) as a pair-programming assistant throughout development. I was responsible for architecture decisions, debugging, validation, and final implementation. The AI generated code drafts that I reviewed, tested, and corrected before committing. Below is the record of how I used it and where its output needed my intervention.

## Phase 1 — Foundation setup

### Design interview and planning

**What I did:** Before writing any code, I ran a structured design interview using the AI to walk through every decision branch — database setup, auth strategy, project structure, cookie configuration, etc. I chose the answers for each question (sometimes overriding the AI's recommendations) and approved the implementation plan only after reviewing it.

I provided the full `claude-code-build-prompt.md` file and asked the AI to interview me about every design decision before generating code (`/grill-me` command). This produced a structured Q&A session covering repository setup, tech-stack confirmation, database strategy, password policy, JWT TTL, cookie settings, monorepo structure, backend architecture, and TypeScript runtime choice.

**What I got:** A thorough requirements walkthrough that surfaced 10+ decisions before implementation began. The AI recommended specific options for each decision with supporting rationale.

**My key overrides:**
- Changed demo user passwords from a single shared password to distinct-but-similar ones per user — more realistic for a graded demo
- Chose feature-based folder structure over the AI's initial recommendation of flat route files, then pulled back from full controller/service layers when I realized it conflicted with the "no unnecessary abstraction" requirement

### Scaffolding and implementation

**What I asked for:** Execute the approved Phase 1 plan — project scaffolding, Prisma schema, auth endpoints, middleware, tests, and frontend shell.

**What the AI got wrong (and what I fixed):**

1. **Prisma 7 compatibility and connection issues (caught during migration and API testing).** The AI generated a Prisma 5/6-style schema with `url = env("DATABASE_URL")` in the datasource block. This was removed in Prisma 7, which I had installed. The migration failed with `P1012: The datasource property 'url' is no longer supported in schema files`. I researched the [Prisma 7 migration guide](https://pris.ly/d/config-datasource), understood the new architecture (CLI config separate from runtime adapter), and directed the fixes across three files: removed `url` from `schema.prisma`, created `prisma.config.ts` for CLI tools, and updated `lib/prisma.ts` to use `PrismaPg` driver adapter. However, the AI incorrectly initialized the adapter with a connection string instead of a `pg.Pool`. Even after fixing that, the server failed to start with an `ECONNREFUSED` error. I diagnosed that this was due to ES6 module import hoisting—`dotenv.config()` was being called too late, leaving the `DATABASE_URL` undefined when the connection pool was initialized. I fixed this by replacing it with a side-effect import (`import 'dotenv/config'`) at the very top of `index.ts`.

2. **Database connection string (caught during migration).** The AI URL-encoded square brackets from my pasted connection string, assuming they were part of the password. The migration failed with `P1000: Authentication failed`. I identified the issue — the brackets were formatting artifacts — and provided the correct encoding (only `@` → `%40`).

3. **Module loading order crash (caught during server startup).** The AI's auth middleware validated `JWT_SECRET` at module import time with a top-level `throw`. But `dotenv.config()` runs in `index.ts`, which is *after* the middleware module loads in the import chain. The server crashed immediately. I diagnosed the import order (`index.ts → app.ts → auth.routes.ts → middleware/auth.ts`) and directed the fix: replace the top-level check with a lazy `getJwtSecret()` function that runs on first request, by which point the env is loaded.

4. **Test file import path (caught during test run).** The auth test imported `app.ts` with a 2-level relative path instead of the correct 3-level path from the `__tests__` directory. Tests failed to compile. Straightforward fix once I looked at the directory structure.

### What this shows

Every issue above was caught by me during execution — running the migration, starting the server, running the tests. The AI doesn't run the code; I do. Each fix required understanding *why* it broke, not just *what* error message appeared. The Prisma 7 issue in particular required reading external documentation and understanding a significant architectural change in the ORM layer.
