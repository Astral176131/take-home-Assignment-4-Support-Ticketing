import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { writeEvent } from './events.js';
import { validateReassignTarget } from './reassignRules.js';
import { checkTransition, STATUS_TO_API } from './stateMachine.js';

const router = Router();

router.use(authenticate);
router.use(requireRole('supervisor'));

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
router.post('/bulk-reassign', async (req: Request, res: Response): Promise<void> => {
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

    await prisma.$transaction(async (tx) => {
      await tx.ticket.update({ where: { id: ticket.id }, data: { assigneeId } });
      await writeEvent(tx, {
        ticketId: ticket.id,
        eventType: 'reassignment',
        actorId: actor.userId,
        oldValue: ticket.assigneeId,
        newValue: assigneeId,
      });
    });

    results.push({ ticket_id: ticketId, success: true });
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
router.post('/bulk-close', async (req: Request, res: Response): Promise<void> => {
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

    await prisma.$transaction(async (tx) => {
      await tx.ticket.update({ where: { id: ticket.id }, data: { status: 'closed', closedAt: new Date() } });
      await writeEvent(tx, {
        ticketId: ticket.id,
        eventType: 'status_change',
        actorId: actor.userId,
        oldValue: STATUS_TO_API[ticket.status],
        newValue: 'closed',
      });
    });

    results.push({ ticket_id: ticketId, success: true });
  }

  res.json(results);
});

export { router as bulkRouter };
