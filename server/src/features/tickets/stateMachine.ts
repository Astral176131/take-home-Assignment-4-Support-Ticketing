import { Role, TicketStatus } from '@prisma/client';
import { REOPEN_WINDOW_DAYS } from '../../lib/config.js';

/** The status names the API speaks; the database calls the first one `new_ticket`. */
export type ApiStatus = 'new' | 'open' | 'pending' | 'resolved' | 'closed';

export const API_STATUSES: ApiStatus[] = ['new', 'open', 'pending', 'resolved', 'closed'];

export const API_TO_STATUS: Record<ApiStatus, TicketStatus> = {
  new: 'new_ticket',
  open: 'open',
  pending: 'pending',
  resolved: 'resolved',
  closed: 'closed',
};

export const STATUS_TO_API: Record<TicketStatus, ApiStatus> = {
  new_ticket: 'new',
  open: 'open',
  pending: 'pending',
  resolved: 'resolved',
  closed: 'closed',
};

/**
 * Every move the brief permits. Anything absent from this list is rejected — the table
 * is the whitelist, not a set of examples.
 */
const TRANSITIONS: Array<{ from: TicketStatus; to: ApiStatus }> = [
  { from: 'new_ticket', to: 'open' },
  { from: 'open', to: 'pending' },
  { from: 'open', to: 'resolved' },
  { from: 'pending', to: 'open' },
  { from: 'resolved', to: 'open' },
  { from: 'resolved', to: 'closed' },
  { from: 'closed', to: 'open' },
];

export interface TransitionContext {
  status: TicketStatus;
  assigneeId: string | null;
  closedAt: Date | null;
  /** The role of whoever is attempting the move. Ticket access is checked separately. */
  role: Role;
  now?: Date;
}

export type TransitionCheck =
  | { ok: true }
  | { ok: false; httpStatus: 403 | 409; message: string };

export function reopenDeadline(closedAt: Date): Date {
  return new Date(closedAt.getTime() + REOPEN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Decides whether one status change is allowed, and says why when it isn't.
 *
 * Pure — no database, no request. The route applies the side effects; this only rules on
 * legality, which is what lets the same logic answer "which buttons should the UI show".
 */
export function checkTransition(to: ApiStatus, ctx: TransitionContext): TransitionCheck {
  const from = STATUS_TO_API[ctx.status];
  const now = ctx.now ?? new Date();

  if (!TRANSITIONS.some((t) => t.from === ctx.status && t.to === to)) {
    return {
      ok: false,
      httpStatus: 409,
      message:
        from === to
          ? `This ticket is already ${to}`
          : `A ticket cannot move from ${from} to ${to}`,
    };
  }

  // A ticket with nobody on it cannot be "in progress".
  if (ctx.status === 'new_ticket' && to === 'open' && !ctx.assigneeId) {
    return {
      ok: false,
      httpStatus: 409,
      message: 'Cannot open a ticket with no assignee',
    };
  }

  // Closing is the one lifecycle action reserved to supervisors.
  if (to === 'closed' && ctx.role !== 'supervisor') {
    return {
      ok: false,
      httpStatus: 403,
      message: 'Only a supervisor can close a ticket',
    };
  }

  // A closed ticket stays reopenable for a fixed window, then it is final.
  if (ctx.status === 'closed' && to === 'open') {
    if (!ctx.closedAt || now > reopenDeadline(ctx.closedAt)) {
      return {
        ok: false,
        httpStatus: 409,
        message: 'The reopen window has expired',
      };
    }
  }

  return { ok: true };
}

/**
 * The moves currently open to this user on this ticket.
 *
 * Derived by asking checkTransition about each candidate, so the UI can never offer a
 * button the endpoint would then refuse — there is only one copy of the rules.
 */
export function allowedTransitions(ctx: TransitionContext): ApiStatus[] {
  return TRANSITIONS.filter((t) => t.from === ctx.status)
    .map((t) => t.to)
    .filter((to) => checkTransition(to, ctx).ok);
}
