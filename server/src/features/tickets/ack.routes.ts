import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate, requireTicketAccess } from '../../middleware/auth.js';
import { writeEvent } from './events.js';
import { computeSla } from './sla.js';
import { ticketPayload } from './detail.js';
import { ConcurrentChange, guardedUpdate, isConcurrentChange } from './concurrency.js';

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
      ackedAt: ticket.ackedAt,
    });

    if (!sla.alert_active) {
      res.status(409).json({ error: 'There is no active alert to acknowledge on this ticket' });
      return;
    }

    // Conditional on nothing else having acknowledged this same alert in the meantime.
    // Two clicks at once would otherwise both succeed and stamp two `sla_ack` rows onto a
    // timeline that cannot be corrected afterwards.
    //
    // The guard matches on `acked_at` rather than on the cycle alone, because an alert can
    // now legitimately be acknowledged more than once per cycle: the snooze expires and
    // the same ticket alerts again. Matching the timestamp we read still rejects the
    // genuine double-submit, since the first writer moves it.
    try {
      await prisma.$transaction(async (tx) => {
        const won = await guardedUpdate(
          tx,
          {
            id: ticket.id,
            ackCycle: ticket.ackCycle,
            ackedAt: ticket.ackedAt,
          },
          { ackedThroughCycle: ticket.ackCycle, ackedAt: new Date() }
        );
        if (!won) throw new ConcurrentChange('There is no active alert to acknowledge on this ticket');

        await writeEvent(tx, {
          ticketId: ticket.id,
          eventType: 'sla_ack',
          actorId: actor.userId,
          newValue: String(ticket.ackCycle),
        });
      });
    } catch (err) {
      if (isConcurrentChange(err)) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }

    res.json((await ticketPayload(ticket.id, actor.role))!);
  }
);

export { router as ackRouter };
