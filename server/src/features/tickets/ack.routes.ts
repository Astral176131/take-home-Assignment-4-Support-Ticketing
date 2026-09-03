import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate, requireTicketAccess } from '../../middleware/auth.js';
import { writeEvent } from './events.js';
import { computeSla } from './sla.js';
import { ticketPayload } from './detail.js';

const router = Router();

router.use(authenticate);

type TicketParams = { id: string };

/**
 * POST /api/tickets/:id/alerts/ack
 *
 * Only meaningful against a currently active alert. Real alert-management tools (PagerDuty,
 * Opsgenie and similar) all tie acknowledgement to a concrete, firing instance — there is
 * nothing to acknowledge about a ticket that isn't currently breaching or in warning, so
 * that case is refused rather than silently accepted.
 *
 * `requireTicketAccess` already encodes exactly the access this needs — a supervisor
 * always, an agent only as assignee or collaborator — the same rule the alerts list uses
 * to decide what an agent even sees.
 */
router.post(
  '/:id/alerts/ack',
  requireTicketAccess,
  async (req: Request<TicketParams>, res: Response): Promise<void> => {
    const actor = req.user!;
    const ticket = await prisma.ticket.findUnique({
      where: { id: req.params.id },
      include: { priority: { select: { targetResponseMinutes: true } } },
    });

    if (!ticket) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }
    if (ticket.archivedAt) {
      res.status(409).json({ error: 'This ticket is archived — restore it before acknowledging an alert' });
      return;
    }

    const sla = computeSla({
      status: ticket.status,
      clockStartedAt: ticket.clockStartedAt,
      pausedMinutes: ticket.pausedMinutes,
      pendingSince: ticket.pendingSince,
      resolvedAt: ticket.resolvedAt,
      closedAt: ticket.closedAt,
      targetResponseMinutes: ticket.priority.targetResponseMinutes,
      ackCycle: ticket.ackCycle,
      ackedThroughCycle: ticket.ackedThroughCycle,
    });

    if (!sla.alert_active) {
      res.status(409).json({ error: 'There is no active alert to acknowledge on this ticket' });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.ticket.update({ where: { id: ticket.id }, data: { ackedThroughCycle: ticket.ackCycle } });
      await writeEvent(tx, {
        ticketId: ticket.id,
        eventType: 'sla_ack',
        actorId: actor.userId,
        newValue: String(ticket.ackCycle),
      });
    });

    res.json((await ticketPayload(ticket.id, actor.role))!);
  }
);

export { router as ackRouter };
