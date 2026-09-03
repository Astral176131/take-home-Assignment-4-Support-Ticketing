import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { authRouter } from './features/auth/auth.routes.js';
import { ticketsRouter } from './features/tickets/tickets.routes.js';
import { repliesRouter } from './features/tickets/replies.routes.js';
import { statusRouter } from './features/tickets/status.routes.js';
import { collaboratorsRouter } from './features/tickets/collaborators.routes.js';
import { reassignRouter } from './features/tickets/reassign.routes.js';
import { bulkRouter } from './features/tickets/bulk.routes.js';
import { agentsRouter } from './features/agents/agents.routes.js';

const app = express();

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
}));

// Routes
app.use('/api/auth', authRouter);
app.use('/api/tickets', ticketsRouter);
app.use('/api/tickets', repliesRouter);
app.use('/api/tickets', statusRouter);
app.use('/api/tickets', collaboratorsRouter);
app.use('/api/tickets', reassignRouter);
app.use('/api/tickets', bulkRouter);
app.use('/api/agents', agentsRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Anything a route throws lands here. Express 5 forwards rejected async handlers
 * automatically, so this catches them too. The client gets a plain JSON error — never a
 * stack trace or an HTML error page — while the detail goes to the server log.
 */
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export { app };
