import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { getJwtSecret } from '../lib/jwt.js';

// Extend Express Request to include user info
declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        email: string;
        role: Role;
      };
    }
  }
}

/**
 * Authenticate middleware — reads JWT from httpOnly cookie, verifies it, and attaches
 * user info to req.user. Returns 401 on missing/invalid/expired token.
 *
 * The signature proves the token was issued here. It does not prove the user still exists,
 * or that they still hold the role the token was minted with — a token stays valid for its
 * full hour, and logging out only clears the cookie in the browser. So identity comes from
 * the token and everything else comes from the database row it points at: a deleted user
 * is refused on their next request rather than an hour later, and an agent promoted or
 * demoted takes effect immediately instead of at the next login.
 *
 * The cost is one indexed primary-key lookup per request, which is the same order as the
 * work every authorized route already does.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.token;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  let payload: { userId: string };
  try {
    payload = jwt.verify(token, getJwtSecret()) as { userId: string };
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, email: true, role: true },
  });

  if (!user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  req.user = { userId: user.id, email: user.email, role: user.role };
  next();
}

/**
 * Role-check middleware — ensures the authenticated user has one of
 * the specified roles. Returns 403 if not.
 * Must be used after `authenticate`.
 */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
}

/**
 * Ticket-access check — verifies the current user can access a given ticket.
 * Supervisors can access any ticket.
 * Agents can only access tickets where they are the assignee or a collaborator.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export async function checkTicketAccess(
  ticketId: string,
  userId: string,
  userRole: Role
): Promise<{ allowed: boolean; reason?: string }> {
  // Fail closed if we don't know who is asking, or about which ticket. Prisma drops
  // `undefined` filter values rather than matching nothing, so an absent userId would
  // otherwise turn the collaborator lookup below into "any collaborator" and allow
  // a stranger through.
  if (!ticketId || !userId) {
    return { allowed: false, reason: 'You do not have access to this ticket' };
  }

  // Supervisors can access any ticket
  if (userRole === 'supervisor') {
    return { allowed: true };
  }

  // For agents, check if they are assignee or collaborator
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: {
      assigneeId: true,
      collaborators: {
        where: { agentId: userId },
        select: { agentId: true },
      },
    },
  });

  // Deliberately the same answer as "this ticket isn't yours". Distinguishing them would
  // tell any agent which ticket ids exist, and the caller cannot act on either case.
  if (!ticket) {
    return { allowed: false, reason: 'You do not have access to this ticket' };
  }

  const isAssignee = ticket.assigneeId === userId;
  const isCollaborator = ticket.collaborators.length > 0;

  if (isAssignee || isCollaborator) {
    return { allowed: true };
  }

  return { allowed: false, reason: 'You do not have access to this ticket' };
}

/**
 * Express middleware version of checkTicketAccess.
 * Expects :id param in the route.
 */
export function requireTicketAccess(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  // Express 5 types a route param as string | string[], since a wildcard can capture
  // several segments. This route takes a single id, so anything else is a bad request.
  const ticketId = req.params.id;
  if (typeof ticketId !== 'string' || !ticketId) {
    res.status(400).json({ error: 'Ticket ID is required' });
    return;
  }

  checkTicketAccess(ticketId, req.user.userId, req.user.role)
    .then((result) => {
      if (!result.allowed) {
        res.status(403).json({ error: result.reason });
        return;
      }
      next();
    })
    // Handed to the central error handler rather than swallowed, so the cause reaches the
    // log instead of a bare 500 with nothing behind it.
    .catch(next);
}
