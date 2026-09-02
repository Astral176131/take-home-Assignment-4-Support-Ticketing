import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { writeEvent } from './events.js';
import { ticketPayload } from './detail.js';

const router = Router();

router.use(authenticate);

type TicketParams = { id: string };
type CollaboratorParams = { id: string; agentId: string };

/**
 * Collaborator management is supervisor-only.
 *
 * This narrows the brief's matrix, which also grants it to the assignee and existing
 * collaborators — see decision 3. The reasoning: an agent already cannot reassign a ticket
 * "not even to another agent", and letting them add a colleague as a collaborator would be
 * the same thing through a side door. Attaching a person to a ticket is a supervisor's call
 * at creation, at reassignment and here alike.
 *
 * Note these routes gate on the role rather than on ticket access: a supervisor can reach
 * any ticket, so `requireRole` is the whole check.
 */

router.post(
  '/:id/collaborators',
  requireRole('supervisor'),
  async (req: Request<TicketParams>, res: Response): Promise<void> => {
    const actor = req.user!;
    const agentId = req.body?.agent_id;

    if (typeof agentId !== 'string' || !agentId) {
      res.status(400).json({ error: 'agent_id is required' });
      return;
    }

    const ticket = await prisma.ticket.findUnique({ where: { id: req.params.id } });
    if (!ticket) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }

    const agent = await prisma.user.findUnique({ where: { id: agentId } });
    if (!agent) {
      res.status(400).json({ error: 'Unknown user' });
      return;
    }
    // Only agents are ever attached to a ticket: a supervisor already sees everything, so
    // a row naming one would grant nothing and clutter the collaborator list.
    if (agent.role !== 'agent') {
      res.status(400).json({ error: 'Only agents can be added as collaborators' });
      return;
    }

    const existing = await prisma.ticketCollaborator.findUnique({
      where: { ticketId_agentId: { ticketId: ticket.id, agentId } },
    });
    if (existing) {
      res.status(409).json({ error: 'That agent is already a collaborator on this ticket' });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.ticketCollaborator.create({ data: { ticketId: ticket.id, agentId } });
      await writeEvent(tx, {
        ticketId: ticket.id,
        eventType: 'collaborator_added',
        actorId: actor.userId,
        newValue: agentId,
      });
    });

    res.status(201).json((await ticketPayload(ticket.id, actor.role))!);
  }
);

router.delete(
  '/:id/collaborators/:agentId',
  requireRole('supervisor'),
  async (req: Request<CollaboratorParams>, res: Response): Promise<void> => {
    const actor = req.user!;
    const { id, agentId } = req.params;

    const existing = await prisma.ticketCollaborator.findUnique({
      where: { ticketId_agentId: { ticketId: id, agentId } },
    });

    if (!existing) {
      res.status(404).json({ error: 'That agent is not a collaborator on this ticket' });
      return;
    }

    // Removal is absolute: unless they are also the assignee, the agent is refused on their
    // very next request. There is no residual read-only state — see decision 10.
    await prisma.$transaction(async (tx) => {
      await tx.ticketCollaborator.delete({
        where: { ticketId_agentId: { ticketId: id, agentId } },
      });
      await writeEvent(tx, {
        ticketId: id,
        eventType: 'collaborator_removed',
        actorId: actor.userId,
        newValue: agentId,
      });
    });

    res.json((await ticketPayload(id, actor.role))!);
  }
);

export { router as collaboratorsRouter };
