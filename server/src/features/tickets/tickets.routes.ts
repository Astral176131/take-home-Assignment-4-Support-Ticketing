import { Router, Request, Response } from 'express';
import { Category, Prisma, Priority, TicketStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { authenticate, requireTicketAccess } from '../../middleware/auth.js';
import { writeEvent } from './events.js';

const router = Router();

// Every ticket route requires a logged-in user.
router.use(authenticate);

const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent'];
const CATEGORIES: Category[] = ['bug', 'billing', 'how_to', 'other'];

/**
 * The schema stores the first state as `new_ticket` because `new` is awkward as an enum
 * member, but the brief's state machine calls it `new` — so the API speaks `new`.
 */
const STATUS_TO_API: Record<TicketStatus, string> = {
  new_ticket: 'new',
  open: 'open',
  pending: 'pending',
  resolved: 'resolved',
  closed: 'closed',
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Customers aren't users of this system — they're identified by email alone, so a
 * ticket either attaches to the existing record or creates it.
 *
 * Deliberately runs outside the ticket transaction. Two agents filing for the same new
 * customer at the same moment both find nothing and both try to insert; the unique index
 * lets exactly one win. Postgres aborts a whole transaction when any statement in it
 * fails, so the loser could not recover from inside one — it reads the winner's row
 * instead. An orphan requester is harmless if the ticket write then fails: it's a
 * customer record with no tickets, not a broken ticket.
 */
async function findOrCreateRequester(name: string, email: string) {
  const existing = await prisma.requester.findUnique({ where: { email } });
  if (existing) return existing;

  try {
    return await prisma.requester.create({ data: { name, email } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const raced = await prisma.requester.findUnique({ where: { email } });
      if (raced) return raced;
    }
    throw err;
  }
}

// --- Serializers -------------------------------------------------------------
// Responses use snake_case to match the vocabulary the brief uses for its fields.

function toListItem(ticket: Prisma.TicketGetPayload<{
  include: { requester: true; assignee: { select: { id: true; name: true } } };
}>) {
  return {
    id: ticket.id,
    subject: ticket.subject,
    status: STATUS_TO_API[ticket.status],
    priority_code: ticket.priorityCode,
    category: ticket.category,
    requester: { id: ticket.requester.id, name: ticket.requester.name, email: ticket.requester.email },
    assignee: ticket.assignee ? { id: ticket.assignee.id, name: ticket.assignee.name } : null,
    archived_at: ticket.archivedAt,
    created_at: ticket.createdAt,
    updated_at: ticket.updatedAt,
  };
}

const detailInclude = {
  requester: true,
  assignee: { select: { id: true, name: true, email: true, role: true } },
  collaborators: {
    include: { agent: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: 'asc' },
  },
  replies: { orderBy: { createdAt: 'asc' } },
  events: {
    orderBy: { createdAt: 'asc' },
    include: { actor: { select: { id: true, name: true } } },
  },
} satisfies Prisma.TicketInclude;

function toDetail(ticket: Prisma.TicketGetPayload<{ include: typeof detailInclude }>) {
  return {
    id: ticket.id,
    subject: ticket.subject,
    description: ticket.description,
    status: STATUS_TO_API[ticket.status],
    priority_code: ticket.priorityCode,
    category: ticket.category,
    requester: ticket.requester,
    assignee: ticket.assignee,
    collaborators: ticket.collaborators.map((c) => c.agent),
    // Empty until replies land in 2.2 and status changes in 2.3, but shaped now so
    // those checkpoints add data rather than reshaping this response.
    replies: ticket.replies.map((r) => ({
      id: r.id,
      body: r.body,
      author_id: r.authorId,
      author_type: r.authorType,
      is_internal: r.isInternal,
      created_at: r.createdAt,
    })),
    events: ticket.events.map((e) => ({
      id: e.id,
      event_type: e.eventType,
      actor: e.actor,
      old_value: e.oldValue,
      new_value: e.newValue,
      created_at: e.createdAt,
    })),
    pending_since: ticket.pendingSince,
    paused_minutes: ticket.pausedMinutes,
    resolved_at: ticket.resolvedAt,
    closed_at: ticket.closedAt,
    archived_at: ticket.archivedAt,
    ack_cycle: ticket.ackCycle,
    acked_through_cycle: ticket.ackedThroughCycle,
    created_at: ticket.createdAt,
    updated_at: ticket.updatedAt,
    // `allowed_transitions` and the SLA figures are added in 2.3, once the state
    // machine and clock exist.
  };
}

function loadDetail(ticketId: string) {
  return prisma.ticket.findUnique({ where: { id: ticketId }, include: detailInclude });
}

// --- Duplicate check ---------------------------------------------------------
// Declared before `/:id` so Express doesn't read the path as a ticket id.

/**
 * GET /api/tickets/duplicate-check?email=...
 *
 * Answers "does this customer already have something open?" before an agent files a
 * second ticket for it — the exact failure the brief opens with. This is a deliberate,
 * narrow exception to "an agent only sees their own tickets": it returns nothing but a
 * subject, a status and who holds it, so an agent can be told "Bob already has this".
 * Reading the ticket itself still goes through the normal access check and 403s.
 */
router.get('/duplicate-check', async (req: Request, res: Response): Promise<void> => {
  const email = typeof req.query.email === 'string' ? normalizeEmail(req.query.email) : '';

  if (!email) {
    res.status(400).json({ error: 'An email is required' });
    return;
  }

  const tickets = await prisma.ticket.findMany({
    where: {
      requester: { email },
      archivedAt: null,
      status: { not: 'closed' },
    },
    select: {
      id: true,
      subject: true,
      status: true,
      assignee: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    items: tickets.map((t) => ({
      id: t.id,
      subject: t.subject,
      status: STATUS_TO_API[t.status],
      assignee: t.assignee,
    })),
    total: tickets.length,
  });
});

// --- Create ------------------------------------------------------------------

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const actor = req.user!;
  const { subject, description, requester, priority_code, category, assignee_id, collaborator_ids } =
    req.body ?? {};

  if (typeof subject !== 'string' || !subject.trim()) {
    res.status(400).json({ error: 'A subject is required' });
    return;
  }
  if (typeof description !== 'string' || !description.trim()) {
    res.status(400).json({ error: 'A description is required' });
    return;
  }
  if (!requester || typeof requester.name !== 'string' || !requester.name.trim()) {
    res.status(400).json({ error: 'A requester name is required' });
    return;
  }
  if (typeof requester.email !== 'string' || !requester.email.includes('@')) {
    res.status(400).json({ error: 'A valid requester email is required' });
    return;
  }
  if (!PRIORITIES.includes(priority_code)) {
    res.status(400).json({ error: `priority_code must be one of: ${PRIORITIES.join(', ')}` });
    return;
  }
  if (!CATEGORIES.includes(category)) {
    res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
    return;
  }

  const requestedCollaborators: string[] = Array.isArray(collaborator_ids)
    ? [...new Set(collaborator_ids.filter((id: unknown) => typeof id === 'string'))]
    : [];

  let collaboratorIds: string[];

  if (actor.role === 'agent') {
    // An agent may pick a ticket up themselves or leave it for triage, but routing work
    // to someone else is a supervisor power — at creation just as it is afterwards.
    if (assignee_id != null && assignee_id !== actor.userId) {
      res.status(403).json({ error: 'An agent can only assign a new ticket to themselves' });
      return;
    }
    if (requestedCollaborators.length > 0) {
      res.status(403).json({ error: 'Only a supervisor can add collaborators' });
      return;
    }
    // The creator is always attached, so they keep access however the ticket is assigned.
    collaboratorIds = [actor.userId];
  } else {
    // A supervisor directs the work without appearing in it: everyone attached to a
    // ticket must be an agent, which rules out both supervisors including themselves.
    const ids = [...new Set([assignee_id, ...requestedCollaborators].filter(Boolean))] as string[];

    if (ids.length > 0) {
      const users = await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, role: true },
      });

      if (users.length !== ids.length) {
        res.status(400).json({ error: 'Unknown user in assignee_id or collaborator_ids' });
        return;
      }
      if (users.some((u) => u.role !== 'agent')) {
        res
          .status(400)
          .json({ error: 'Only agents can be assigned to or added as collaborators on a ticket' });
        return;
      }
    }

    collaboratorIds = requestedCollaborators;
  }

  // An existing requester keeps their name: a typo on one ticket shouldn't rewrite the
  // customer's name across their whole history.
  const requesterRecord = await findOrCreateRequester(
    requester.name.trim(),
    normalizeEmail(requester.email)
  );

  const ticketId = await prisma.$transaction(async (tx) => {
    const created = await tx.ticket.create({
      data: {
        subject: subject.trim(),
        description: description.trim(),
        requesterId: requesterRecord.id,
        priorityCode: priority_code,
        category,
        assigneeId: assignee_id ?? null,
      },
    });

    for (const agentId of collaboratorIds) {
      await tx.ticketCollaborator.create({ data: { ticketId: created.id, agentId } });
      await writeEvent(tx, {
        ticketId: created.id,
        eventType: 'collaborator_added',
        actorId: actor.userId,
        newValue: agentId,
      });
    }

    return created.id;
  });

  res.status(201).json(toDetail((await loadDetail(ticketId))!));
});

// --- List --------------------------------------------------------------------

/**
 * Minimal queue list. Search, filters, sorting and pagination arrive in Phase 4; the
 * `{ items, total }` shape is already what Phase 4 will return, so that phase extends
 * this endpoint rather than reshaping it.
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const actor = req.user!;
  const includeArchived = req.query.archived === 'true';

  const where: Prisma.TicketWhereInput = {};

  if (!includeArchived) {
    where.archivedAt = null;
  }

  // Scoping happens in the query, not by fetching everything and filtering in Node.
  if (actor.role === 'agent') {
    where.OR = [
      { assigneeId: actor.userId },
      { collaborators: { some: { agentId: actor.userId } } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.ticket.findMany({
      where,
      include: { requester: true, assignee: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.ticket.count({ where }),
  ]);

  res.json({ items: items.map(toListItem), total });
});

// --- Read one ----------------------------------------------------------------

// Express 5 types params as string | string[]; naming the shape keeps `id` a string.
type TicketParams = { id: string };

router.get('/:id', requireTicketAccess, async (req: Request<TicketParams>, res: Response): Promise<void> => {
  const ticket = await loadDetail(req.params.id);

  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }

  res.json(toDetail(ticket));
});

// --- Edit fields -------------------------------------------------------------

router.patch('/:id', requireTicketAccess, async (req: Request<TicketParams>, res: Response): Promise<void> => {
  const { subject, description, priority_code, category } = req.body ?? {};

  // Anything that carries its own rules gets its own endpoint, so a generic edit can
  // never be used to slip past the state machine or the reassignment check.
  if ('status' in (req.body ?? {})) {
    res.status(400).json({ error: 'Status changes go through POST /api/tickets/:id/status' });
    return;
  }
  if ('assignee_id' in (req.body ?? {})) {
    res.status(400).json({ error: 'Assignee changes go through POST /api/tickets/:id/reassign' });
    return;
  }
  if ('archived_at' in (req.body ?? {})) {
    res.status(400).json({ error: 'Use POST /api/tickets/:id/archive or /restore' });
    return;
  }

  const data: Prisma.TicketUpdateInput = {};

  if (subject !== undefined) {
    if (typeof subject !== 'string' || !subject.trim()) {
      res.status(400).json({ error: 'A subject is required' });
      return;
    }
    data.subject = subject.trim();
  }
  if (description !== undefined) {
    if (typeof description !== 'string' || !description.trim()) {
      res.status(400).json({ error: 'A description is required' });
      return;
    }
    data.description = description.trim();
  }
  if (priority_code !== undefined) {
    if (!PRIORITIES.includes(priority_code)) {
      res.status(400).json({ error: `priority_code must be one of: ${PRIORITIES.join(', ')}` });
      return;
    }
    data.priority = { connect: { code: priority_code } };
  }
  if (category !== undefined) {
    if (!CATEGORIES.includes(category)) {
      res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
      return;
    }
    data.category = category;
  }

  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: 'No editable fields supplied' });
    return;
  }

  const existing = await prisma.ticket.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }

  // Field edits write no history row: the brief's timeline covers status changes,
  // reassignments and replies, and ticket_events has no event type for a field edit.
  await prisma.ticket.update({ where: { id: req.params.id }, data });

  res.json(toDetail((await loadDetail(req.params.id))!));
});

// --- Archive / restore -------------------------------------------------------

router.post('/:id/archive', requireTicketAccess, async (req: Request<TicketParams>, res: Response): Promise<void> => {
  const actor = req.user!;
  const ticket = await prisma.ticket.findUnique({ where: { id: req.params.id } });

  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }
  if (ticket.archivedAt) {
    res.status(409).json({ error: 'This ticket is already archived' });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.ticket.update({ where: { id: ticket.id }, data: { archivedAt: new Date() } });
    await writeEvent(tx, { ticketId: ticket.id, eventType: 'archived', actorId: actor.userId });
  });

  res.json(toDetail((await loadDetail(ticket.id))!));
});

router.post('/:id/restore', requireTicketAccess, async (req: Request<TicketParams>, res: Response): Promise<void> => {
  const actor = req.user!;
  const ticket = await prisma.ticket.findUnique({ where: { id: req.params.id } });

  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }
  if (!ticket.archivedAt) {
    res.status(409).json({ error: 'This ticket is not archived' });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.ticket.update({ where: { id: ticket.id }, data: { archivedAt: null } });
    await writeEvent(tx, { ticketId: ticket.id, eventType: 'restored', actorId: actor.userId });
  });

  res.json(toDetail((await loadDetail(ticket.id))!));
});

export { router as ticketsRouter };
