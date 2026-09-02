import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { authenticate, requireTicketAccess } from '../../middleware/auth.js';
import { writeEvent } from './events.js';
import { pauseCreditMinutes } from './clock.js';
import { loadTicketDetail, toTicketDetail } from './detail.js';
import {
  API_STATUSES,
  API_TO_STATUS,
  ApiStatus,
  STATUS_TO_API,
  checkTransition,
} from './stateMachine.js';

const router = Router();

router.use(authenticate);

type TicketParams = { id: string };

/**
 * POST /api/tickets/:id/status
 *
 * The only way a ticket's status changes by hand. Legality is decided by the state
 * machine; this route owns the side effects each move carries, and writes the history
 * row in the same transaction so a status can never change without a record of it.
 */
router.post(
  '/:id/status',
  requireTicketAccess,
  async (req: Request<TicketParams>, res: Response): Promise<void> => {
    const actor = req.user!;
    const target = req.body?.status as ApiStatus;

    // An unknown value is a malformed request; a known value that isn't a legal move is
    // a conflict with the ticket's current state. Different problems, different codes.
    if (!API_STATUSES.includes(target)) {
      res.status(400).json({ error: `status must be one of: ${API_STATUSES.join(', ')}` });
      return;
    }

    const ticket = await prisma.ticket.findUnique({ where: { id: req.params.id } });

    if (!ticket) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }
    if (ticket.archivedAt) {
      res.status(409).json({ error: 'This ticket is archived — restore it before changing its status' });
      return;
    }

    const verdict = checkTransition(target, {
      status: ticket.status,
      assigneeId: ticket.assigneeId,
      closedAt: ticket.closedAt,
      role: actor.role,
    });

    if (!verdict.ok) {
      res.status(verdict.httpStatus).json({ error: verdict.message });
      return;
    }

    const now = new Date();
    const data: Prisma.TicketUpdateInput = { status: API_TO_STATUS[target] };

    if (target === 'pending') {
      data.pendingSince = now;
    }

    if (ticket.status === 'pending' && target === 'open') {
      // Leaving pending credits the waiting time back, exactly as a customer reply does.
      data.pendingSince = null;
      data.pausedMinutes = {
        increment: ticket.pendingSince ? pauseCreditMinutes(ticket.pendingSince, now) : 0,
      };
    }

    if (target === 'resolved') {
      data.resolvedAt = now;
    }

    if (target === 'closed') {
      data.closedAt = now;
    }

    if (ticket.status === 'closed' && target === 'open') {
      // Reopening a finished ticket begins a new response cycle: the clock restarts from
      // zero with no inherited pause credit, and the higher ack_cycle makes any earlier
      // acknowledgement stale so a fresh breach can raise its alert again.
      data.ackCycle = { increment: 1 };
      data.clockStartedAt = now;
      data.pausedMinutes = 0;
    }

    await prisma.$transaction(async (tx) => {
      await tx.ticket.update({ where: { id: ticket.id }, data });
      await writeEvent(tx, {
        ticketId: ticket.id,
        eventType: 'status_change',
        actorId: actor.userId,
        oldValue: STATUS_TO_API[ticket.status],
        newValue: target,
      });
    });

    res.json(toTicketDetail((await loadTicketDetail(ticket.id))!, actor.role));
  }
);

export { router as statusRouter };
