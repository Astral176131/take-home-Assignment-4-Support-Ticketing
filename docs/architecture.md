# Architecture

## Moving pieces and how they communicate

The system has three independently deployed components:

1. **React Frontend (client/)** — A Vite-built single-page application. Runs in the browser. Communicates with the API over HTTPS using `fetch()` with `credentials: 'include'` to send httpOnly cookies. In development, Vite's dev server proxies `/api/*` requests to the backend on port 3000.

2. **Express API (server/)** — A Node.js + Express + TypeScript REST API. Handles all business logic, authentication, and authorization. Connects to PostgreSQL via Prisma ORM with the `@prisma/adapter-pg` driver adapter (required by Prisma 7). Stateless — all session state lives in the JWT cookie.

3. **PostgreSQL Database** — Managed by Supabase (free tier). Holds all persistent data. Schema managed via Prisma migrations. A separate Supabase project is used for the test database.

```
Browser ──(HTTPS)──▶ Vite Frontend (Vercel)
                          │
                          │ /api/* proxy (dev) or rewrite (prod)
                          ▼
                     Express API (Render)
                          │
                          │ PostgreSQL protocol (TLS)
                          ▼
                     PostgreSQL (Supabase)
```

## Where each piece runs

| Component | Local dev | Production |
|-----------|-----------|------------|
| Frontend | `localhost:5173` (Vite dev server) | Vercel |
| API | `localhost:3000` (tsx watch) | Render |
| Database | Supabase (remote, free tier) | Supabase (same instance) |

## Request path: user logs in

1. User enters email + password on the login page (`/login`)
2. Browser sends `POST /api/auth/login` with `{ email, password }` as JSON
3. Vite proxy (dev) or Vercel rewrite (prod) forwards the request to the Express API
4. Express parses the JSON body, looks up the user by email in PostgreSQL via Prisma
5. `bcrypt.compare()` verifies the password against the stored hash
6. On success, `jsonwebtoken.sign()` creates a JWT with `{ userId, email, role }` (1h expiry)
7. The JWT is set as an `httpOnly, secure (prod), sameSite=lax` cookie on the response
8. The response body returns `{ user: { id, email, name, role } }` (no password hash)
9. The React `AuthContext` stores the user in state and redirects to `/`
10. Subsequent requests include the cookie automatically — `authenticate` middleware reads it

## What I decided not to build

- **Self-registration UI** — The brief never asks for one. Users are created via the seed script.
- **Refresh tokens** — With a 1-hour JWT TTL and this being a support tool (not a consumer app), the complexity of refresh token rotation isn't justified. If a session expires, the user logs in again.
- **WebSocket / real-time updates** — Not in the requirements. Polling or manual refresh is sufficient for a support queue. Would add it if the brief asked for live collaboration.
- **Email sending** — Replies are logged in the system; actual email delivery is out of scope.
