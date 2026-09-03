import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { writeEvent } from './events.js';
import { ticketPayload } from './detail.js';
import { validateReassignTarget } from './reassignRules.js';

const router = Router();

router.use(authenticate);

type TicketParams = { id: string };

/**
 * POST /api/tickets/:id/reassign
 *
 * Supervisor-only, with no exceptions. An agent cannot reassign a ticket away from
 * themselves, to a colleague, or even to themselves — the role gate refuses all of it
 * before the body is read.
 *
 * The target must be an agent, or the acting supervisor personally. That second case is
 * the one route by which a supervisor becomes an assignee: taking over an escalation
 * (decision 4). A supervisor still cannot hand work to the *other* supervisor, which keeps
 * "assignee" meaning the person doing the work rather than the person overseeing it.
 *
 * Reassignment is a clean handoff. The previous assignee is not added as a collaborator
 * and is refused on their very next request unless they were separately attached — there
 * is no residual read-only state (decision 10).
 */
router.post(
  '/:id/reassign',
  requireRole('supervisor'),
  async (req: Request<TicketParams>, res: Response): Promise<void> => {
    const actor = req.user!;
    const assigneeId = req.body?.assignee_id;

    if (typeof assigneeId !== 'string' || !assigneeId) {
      res.status(400).json({ error: 'assignee_id is required' });
      return;
    }

    const ticket = await prisma.ticket.findUnique({ where: { id: req.params.id } });
    if (!ticket) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }
    if (ticket.archivedAt) {
      res.status(409).json({ error: 'This ticket is archived — restore it before reassigning' });
      return;
    }
    if (ticket.assigneeId === assigneeId) {
      res.status(409).json({ error: 'That agent already holds this ticket' });
      return;
    }

    const targetCheck = await validateReassignTarget(actor.userId, assigneeId);
    if (!targetCheck.ok) {
      res.status(400).json({ error: targetCheck.error });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.ticket.update({ where: { id: ticket.id }, data: { assigneeId } });
      await writeEvent(tx, {
        ticketId: ticket.id,
        eventType: 'reassignment',
        actorId: actor.userId,
        // Both ends recorded: who held it, and who holds it now.
        oldValue: ticket.assigneeId,
        newValue: assigneeId,
      });
    });

    res.json((await ticketPayload(ticket.id, actor.role))!);
  }
);

export { router as reassignRouter };
