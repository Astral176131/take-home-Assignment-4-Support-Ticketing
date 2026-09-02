import { Router, Request, Response } from 'express';
import { AuthorType } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { authenticate, requireTicketAccess } from '../../middleware/auth.js';
import { writeEvent } from './events.js';
import { pauseCreditMinutes } from './clock.js';
import { ticketPayload } from './detail.js';

const router = Router();

router.use(authenticate);

const AUTHOR_TYPES: AuthorType[] = ['agent', 'customer'];

type TicketParams = { id: string };

/**
 * POST /api/tickets/:id/replies
 *
 * `author_type: 'customer'` is how an agent logs an email the customer sent. The author
 * recorded is always the logged-in user, because customers are not users of this system
 * — the reply is a record of what the customer said, written down by an agent.
 */
router.post(
  '/:id/replies',
  requireTicketAccess,
  async (req: Request<TicketParams>, res: Response): Promise<void> => {
    const actor = req.user!;
    const { body, is_internal, author_type } = req.body ?? {};

    if (typeof body !== 'string' || !body.trim()) {
      res.status(400).json({ error: 'A reply body is required' });
      return;
    }

    const authorType: AuthorType = author_type ?? 'agent';
    if (!AUTHOR_TYPES.includes(authorType)) {
      res.status(400).json({ error: `author_type must be one of: ${AUTHOR_TYPES.join(', ')}` });
      return;
    }

    const isInternal = is_internal === true;
    if (authorType === 'customer' && isInternal) {
      res.status(400).json({ error: "A customer's reply cannot be an internal note" });
      return;
    }

    const ticket = await prisma.ticket.findUnique({ where: { id: req.params.id } });

    if (!ticket) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }
    if (ticket.archivedAt) {
      res.status(409).json({ error: 'This ticket is archived — restore it before replying' });
      return;
    }

    // The one automatic transition in the whole state machine: `pending` means waiting on
    // the customer, so the customer answering hands the ticket back to the team and
    // restarts the clock. An agent chasing them does not — nobody has replied yet. A
    // closed ticket stays closed; reopening one is a deliberate act inside its window.
    const reopensFromPending = authorType === 'customer' && ticket.status === 'pending';

    await prisma.$transaction(async (tx) => {
      const reply = await tx.reply.create({
        data: {
          ticketId: ticket.id,
          authorId: actor.userId,
          authorType,
          body: body.trim(),
          isInternal,
        },
      });

      await writeEvent(tx, {
        ticketId: ticket.id,
        eventType: 'reply_added',
        actorId: actor.userId,
        // Points the timeline entry at the reply that produced it.
        newValue: reply.id,
      });

      if (reopensFromPending) {
        await tx.ticket.update({
          where: { id: ticket.id },
          data: {
            status: 'open',
            pendingSince: null,
            pausedMinutes: {
              increment: ticket.pendingSince ? pauseCreditMinutes(ticket.pendingSince) : 0,
            },
          },
        });

        await writeEvent(tx, {
          ticketId: ticket.id,
          eventType: 'status_change',
          actorId: actor.userId,
          oldValue: 'pending',
          newValue: 'open',
        });
      }
    });

    res.status(201).json((await ticketPayload(ticket.id, actor.role))!);
  }
);

export { router as repliesRouter };
