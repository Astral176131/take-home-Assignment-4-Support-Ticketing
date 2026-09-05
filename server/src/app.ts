import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { authRouter } from './features/auth/auth.routes.js';
import { ticketsRouter } from './features/tickets/tickets.routes.js';
import { exportRouter } from './features/tickets/export.routes.js';
import { repliesRouter } from './features/tickets/replies.routes.js';
import { statusRouter } from './features/tickets/status.routes.js';
import { collaboratorsRouter } from './features/tickets/collaborators.routes.js';
import { reassignRouter } from './features/tickets/reassign.routes.js';
import { bulkRouter } from './features/tickets/bulk.routes.js';
import { ackRouter } from './features/tickets/ack.routes.js';
import { agentsRouter } from './features/agents/agents.routes.js';
import { dashboardRouter } from './features/dashboard/dashboard.routes.js';
import { alertsRouter } from './features/alerts/alerts.routes.js';

const app = express();

/** The single origin the browser app is served from; CORS and the CSRF check share it. */
const CLIENT_ORIGIN = process.env.CLIENT_URL || 'http://localhost:5173';

// Nothing is gained by telling every caller which framework this is.
app.disable('x-powered-by');

// Middleware
// An explicit limit rather than body-parser's implicit 100kb default, so the bound on a
// request body is a decision recorded here rather than a library's choice.
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(cors({
  origin: CLIENT_ORIGIN,
  credentials: true,
}));

app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

/**
 * CSRF: refuse a state-changing request that a browser says came from somewhere else.
 *
 * CORS alone does not cover this. It stops an attacker *reading* a response, but a form
 * post is a "simple request" — no preflight — so the side effect has already happened by
 * the time CORS gets involved. Most routes here are incidentally protected because they
 * require `application/json`, which does force a preflight; the ones taking no body at all
 * (archive, restore, alerts/ack) are not, and in production the session cookie is
 * `SameSite=None` because the client and API are genuinely cross-origin, so the browser
 * would attach it. That combination is exactly what a cross-site form post needs.
 *
 * Checking `Origin` closes it: browsers set it on every cross-origin request and cannot be
 * talked out of it from script. A request with no `Origin` at all is not a browser doing
 * this — that is curl, or the test suite, or the seed script — and is left alone.
 */
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

app.use((req: Request, res: Response, next: NextFunction) => {
  if (!STATE_CHANGING.has(req.method)) return next();

  const origin = req.get('origin');
  if (origin && origin !== CLIENT_ORIGIN) {
    res.status(403).json({ error: 'Cross-origin requests are not allowed' });
    return;
  }
  next();
});

// Routes
app.use('/api/auth', authRouter);
// exportRouter is mounted before ticketsRouter: its literal path "/export.csv" would
// otherwise be swallowed by ticketsRouter's GET /:id, which matches any single segment.
app.use('/api/tickets', exportRouter);
app.use('/api/tickets', ticketsRouter);
app.use('/api/tickets', repliesRouter);
app.use('/api/tickets', statusRouter);
app.use('/api/tickets', collaboratorsRouter);
app.use('/api/tickets', reassignRouter);
app.use('/api/tickets', bulkRouter);
app.use('/api/tickets', ackRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/alerts', alertsRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * No route matched. Without this Express answers with its own HTML page, which a client
 * that only ever parses JSON reads as a parse failure rather than as "no such endpoint".
 */
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

/**
 * Anything a route throws lands here. Express 5 forwards rejected async handlers
 * automatically, so this catches them too. The client gets a plain JSON error — never a
 * stack trace or an HTML error page — while the detail goes to the server log.
 *
 * A 4xx that arrives with its own status is passed through rather than flattened to 500.
 * Body-parser throws exactly this for a malformed JSON body: an error already carrying
 * `status: 400` and `expose: true`, which was being reported to the caller as an internal
 * server error — blaming the server for a request the client got wrong.
 */
app.use((err: Error & { status?: number; statusCode?: number; expose?: boolean }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status ?? err.statusCode;

  if (typeof status === 'number' && status >= 400 && status < 500) {
    // `expose` is body-parser's own signal that the message is safe to show a caller.
    res.status(status).json({ error: err.expose ? err.message : 'Bad request' });
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export { app };
