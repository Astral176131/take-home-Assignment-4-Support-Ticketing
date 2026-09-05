import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { writeEvent } from './events.js';
import { validateReassignTarget } from './reassignRules.js';
import { validateCollaboratorTarget } from './collaboratorRules.js';
import { checkTransition, STATUS_TO_API } from './stateMachine.js';
import { ConcurrentChange, guardedUpdate, isConcurrentChange } from './concurrency.js';

const router = Router();

router.use(authenticate);

// requireRole('supervisor') is applied per-route below, not here via router.use(). Several
// routers share the '/api/tickets' mount prefix, and a path-less router.use() runs for
// every request reaching that prefix — including ones this router has no matching route
// for — regardless of which router is mounted next. A blanket requireRole('supervisor')
// here previously 403'd every /api/tickets/* request from a non-supervisor that happened
// to be handled by a router mounted after this one, with no route in this file involved at
// all. Caught when ack.routes.ts, mounted after this file, started failing for agents.

const MAX_BULK_IDS = 100;

interface BulkResult {
  ticket_id: string;
  success: boolean;
  reason?: string;
}

/**
 * Reads and validates `ticket_ids`, common to both bulk routes.
 *
 * De-duplicated so the same id can't appear twice in the report claiming two different
 * outcomes. Returns null and writes the response itself when the input is malformed —
 * the caller just returns in that case.
 */
function readTicketIds(req: Request, res: Response): string[] | null {
  const raw = req.body?.ticket_ids;

  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) {
    res.status(400).json({ error: 'ticket_ids must be an array of strings' });
    return null;
  }

  const ids = [...new Set(raw)];

  if (ids.length === 0) {
    res.status(400).json({ error: 'ticket_ids must contain at least one id' });
    return null;
  }
  if (ids.length > MAX_BULK_IDS) {
    res.status(400).json({ error: `ticket_ids cannot exceed ${MAX_BULK_IDS} at a time` });
    return null;
  }

  return ids;
}

/**
 * POST /api/tickets/bulk-reassign
 *
 * Never an all-or-nothing failure: a selection off the queue routinely mixes eligible and
 * ineligible tickets, so this always returns 200 with one result per ticket, and each
 * ticket's write is its own transaction so one failure cannot roll back another's success.
 *
 * The target is validated once for the whole batch — it is the same rule the single
 * reassign endpoint enforces (agent, or the caller themselves as an escalation, never the
 * other supervisor) and it does not depend on any individual ticket, so a bad target fails
 * the request up front rather than repeating the same reason on every line.
 *
 * A ticket already assigned to the target counts as success: the caller's intent is "these
 * tickets end up with this person", and a mixed batch where some already do should not
 * read as partly failed. This is the one place bulk-reassign departs from the single
 * endpoint, which treats the identical case as a 409 — there, the caller named one ticket
 * and something aside from the ticket refused to move; here, nothing was asked to move.
 */
router.post('/bulk-reassign', requireRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
  const actor = req.user!;
  const ids = readTicketIds(req, res);
  if (!ids) return;

  const assigneeId = req.body?.assignee_id;
  if (typeof assigneeId !== 'string' || !assigneeId) {
    res.status(400).json({ error: 'assignee_id is required' });
    return;
  }

  const targetCheck = await validateReassignTarget(actor.userId, assigneeId);
  if (!targetCheck.ok) {
    res.status(400).json({ error: targetCheck.error });
    return;
  }

  const results: BulkResult[] = [];

  for (const ticketId of ids) {
    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });

    if (!ticket) {
      results.push({ ticket_id: ticketId, success: false, reason: 'Ticket not found' });
      continue;
    }
    if (ticket.archivedAt) {
      results.push({
        ticket_id: ticketId,
        success: false,
        reason: 'This ticket is archived — restore it before reassigning',
      });
      continue;
    }
    if (ticket.assigneeId === assigneeId) {
      results.push({ ticket_id: ticketId, success: true });
      continue;
    }

    // Guarded on the holder this batch read, so a ticket someone reassigned while the batch
    // was running is reported rather than silently overwritten with a history row naming
    // the wrong previous assignee.
    let won = false;
    await prisma.$transaction(async (tx) => {
      won = await guardedUpdate(
        tx,
        { id: ticket.id, assigneeId: ticket.assigneeId, archivedAt: null },
        { assigneeId }
      );
      if (!won) return;

      await writeEvent(tx, {
        ticketId: ticket.id,
        eventType: 'reassignment',
        actorId: actor.userId,
        oldValue: ticket.assigneeId,
        newValue: assigneeId,
      });
    });

    results.push(
      won
        ? { ticket_id: ticketId, success: true }
        : {
            ticket_id: ticketId,
            success: false,
            reason: 'This ticket changed while the batch was running',
          }
    );
  }

  res.json(results);
});

/**
 * POST /api/tickets/bulk-close
 *
 * Reuses the same state machine the single status endpoint enforces, so a ticket that
 * isn't `resolved` comes back with the same specific reason ("A ticket cannot move from
 * open to closed") rather than a generic skip. Supervisor-only is the route's own gate;
 * closing itself needs no further per-ticket permission check.
 */
router.post('/bulk-close', requireRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
  const actor = req.user!;
  const ids = readTicketIds(req, res);
  if (!ids) return;

  const results: BulkResult[] = [];

  for (const ticketId of ids) {
    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });

    if (!ticket) {
      results.push({ ticket_id: ticketId, success: false, reason: 'Ticket not found' });
      continue;
    }
    if (ticket.archivedAt) {
      results.push({
        ticket_id: ticketId,
        success: false,
        reason: 'This ticket is archived — restore it before changing its status',
      });
      continue;
    }

    const verdict = checkTransition('closed', {
      status: ticket.status,
      assigneeId: ticket.assigneeId,
      closedAt: ticket.closedAt,
      role: actor.role,
    });

    if (!verdict.ok) {
      results.push({ ticket_id: ticketId, success: false, reason: verdict.message });
      continue;
    }

    // Guarded on the status the state machine just ruled against, so a ticket closed by
    // someone else mid-batch is reported instead of being closed a second time — which
    // would put two `closed` rows on a timeline that cannot be corrected afterwards.
    let won = false;
    await prisma.$transaction(async (tx) => {
      won = await guardedUpdate(
        tx,
        { id: ticket.id, status: ticket.status, archivedAt: null },
        { status: 'closed', closedAt: new Date() }
      );
      if (!won) return;

      await writeEvent(tx, {
        ticketId: ticket.id,
        eventType: 'status_change',
        actorId: actor.userId,
        oldValue: STATUS_TO_API[ticket.status],
        newValue: 'closed',
      });
    });

    results.push(
      won
        ? { ticket_id: ticketId, success: true }
        : {
            ticket_id: ticketId,
            success: false,
            reason: 'This ticket changed while the batch was running',
          }
    );
  }

  res.json(results);
});

/**
 * POST /api/tickets/bulk-collaborators
 *
 * Adds or removes one agent across a selection, `{ ticket_ids, agent_id, action }`.
 *
 * The same shape as the other two: supervisor-only, one transaction per ticket, and a
 * per-ticket report rather than an all-or-nothing failure — a selection off the queue
 * routinely mixes tickets the agent is already on with ones they are not, and neither is
 * an error worth failing the batch for.
 *
 * Adding someone already on a ticket, or removing someone who was not on it, is reported
 * as a refusal with its reason rather than silently counted as success. That differs from
 * bulk-reassign, where a ticket already held by the target counts as success: there the
 * caller's intent is "these end up with this person" and it already does, whereas here the
 * two actions are opposites and quietly succeeding at a no-op hides a mis-click.
 */
router.post('/bulk-collaborators', requireRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
  const actor = req.user!;
  const ids = readTicketIds(req, res);
  if (!ids) return;

  const agentId = req.body?.agent_id;
  if (typeof agentId !== 'string' || !agentId) {
    res.status(400).json({ error: 'agent_id is required' });
    return;
  }

  const action = req.body?.action;
  if (action !== 'add' && action !== 'remove') {
    res.status(400).json({ error: "action must be one of: add, remove" });
    return;
  }

  // Validated once for the whole batch: it does not depend on any individual ticket, so a
  // bad target fails the request up front rather than repeating itself on every line.
  const targetCheck = await validateCollaboratorTarget(agentId);
  if (!targetCheck.ok) {
    res.status(400).json({ error: targetCheck.error });
    return;
  }

  const results: BulkResult[] = [];

  for (const ticketId of ids) {
    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });

    if (!ticket) {
      results.push({ ticket_id: ticketId, success: false, reason: 'Ticket not found' });
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        if (action === 'add') {
          // No read-then-write check: the composite primary key decides, and a duplicate
          // surfaces as P2002 below. Checking first would be the same race the single
          // endpoint had.
          await tx.ticketCollaborator.create({ data: { ticketId: ticket.id, agentId } });
        } else {
          const { count } = await tx.ticketCollaborator.deleteMany({
            where: { ticketId: ticket.id, agentId },
          });
          if (count === 0) throw new ConcurrentChange('That agent is not a collaborator on this ticket');
        }

        await writeEvent(tx, {
          ticketId: ticket.id,
          eventType: action === 'add' ? 'collaborator_added' : 'collaborator_removed',
          actorId: actor.userId,
          newValue: agentId,
        });
      });

      results.push({ ticket_id: ticketId, success: true });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        results.push({
          ticket_id: ticketId,
          success: false,
          reason: 'That agent is already a collaborator on this ticket',
        });
        continue;
      }
      if (isConcurrentChange(err)) {
        results.push({ ticket_id: ticketId, success: false, reason: err.message });
        continue;
      }
      throw err;
    }
  }

  res.json(results);
});

export { router as bulkRouter };
