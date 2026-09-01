import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

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

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  return secret;
}

/**
 * Authenticate middleware — reads JWT from httpOnly cookie,
 * verifies it, and attaches user info to req.user.
 * Returns 401 on missing/invalid/expired token.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.token;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const payload = jwt.verify(token, getJwtSecret()) as {
      userId: string;
      email: string;
      role: Role;
    };

    req.user = {
      userId: payload.userId,
      email: payload.email,
      role: payload.role,
    };

    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
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

  if (!ticket) {
    return { allowed: false, reason: 'Ticket not found' };
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

  const ticketId = req.params.id;
  if (!ticketId) {
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
    .catch((err) => {
      res.status(500).json({ error: 'Internal server error' });
    });
}
