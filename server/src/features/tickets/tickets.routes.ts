import { Router, Request, Response } from 'express';
import { Category, Prisma, Priority } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { authenticate, requireTicketAccess } from '../../middleware/auth.js';
import { writeEvent } from './events.js';
import { STATUS_TO_API, ticketPayload } from './detail.js';
import { computeSla } from './sla.js';
import { ticketKey } from './key.js';
import { buildTicketWhere, resolveTicketSort, resolvePagination } from './query.js';

const router = Router();

// Every ticket route requires a logged-in user.
router.use(authenticate);

const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent'];
const CATEGORIES: Category[] = ['bug', 'billing', 'how_to', 'other'];

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

// Exported: alertCandidates.ts reuses both so the queue row shape isn't defined twice.
export const listInclude = {
  requester: true,
  priority: true,
  assignee: { select: { id: true, name: true } },
} satisfies Prisma.TicketInclude;

export function toListItem(ticket: Prisma.TicketGetPayload<{ include: typeof listInclude }>) {
  return {
    id: ticket.id,
    key: ticketKey(ticket.number),
    subject: ticket.subject,
    status: STATUS_TO_API[ticket.status],
    priority_code: ticket.priorityCode,
    category: ticket.category,
    requester: { id: ticket.requester.id, name: ticket.requester.name, email: ticket.requester.email },
    assignee: ticket.assignee ? { id: ticket.assignee.id, name: ticket.assignee.name } : null,
    // The queue's whole purpose is spotting what is at risk, so each row carries its own
    // SLA standing rather than making the browser fetch every ticket to work it out.
    sla: computeSla({
      status: ticket.status,
      clockStartedAt: ticket.clockStartedAt,
      pausedMinutes: ticket.pausedMinutes,
      pendingSince: ticket.pendingSince,
      resolvedAt: ticket.resolvedAt,
      closedAt: ticket.closedAt,
      targetResponseMinutes: ticket.priority.targetResponseMinutes,
      ackCycle: ticket.ackCycle,
      ackedThroughCycle: ticket.ackedThroughCycle,
    }),
    archived_at: ticket.archivedAt,
    created_at: ticket.createdAt,
    updated_at: ticket.updatedAt,
  };
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

  res.status(201).json((await ticketPayload(ticketId, actor.role))!);
});

// --- List --------------------------------------------------------------------

/**
 * The queue: search, filter, sort and paginate, entirely in the database. This route
 * builds a query object and hands it to Prisma; Postgres does the matching, ordering and
 * page slicing. Access scoping is folded into `buildTicketWhere` unconditionally, so no
 * combination of query parameters can widen what an agent is allowed to see.
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const actor = req.user!;

  const where = buildTicketWhere(actor, req.query);
  if (!where.ok) {
    res.status(400).json({ error: where.error });
    return;
  }

  const orderBy = resolveTicketSort(req.query);
  if (!orderBy.ok) {
    res.status(400).json({ error: orderBy.error });
    return;
  }

  const { page, pageSize, skip } = resolvePagination(req.query);

  const [items, total] = await Promise.all([
    prisma.ticket.findMany({
      where: where.value,
      include: listInclude,
      orderBy: orderBy.value,
      skip,
      take: pageSize,
    }),
    prisma.ticket.count({ where: where.value }),
  ]);

  res.json({ items: items.map(toListItem), total, page, page_size: pageSize });
});

/**
 * GET /api/tickets/mine — the tickets this person is actually on.
 *
 * Declared before `/:id` so Express doesn't read "mine" as a ticket id.
 *
 * For an agent this returns the same set as the list above, which already scopes them to
 * their own work. The difference shows for a supervisor: `/` gives them the whole queue,
 * while this gives only the tickets they hold personally — which, per decision 4, means
 * escalations they have taken over.
 */
router.get('/mine', async (req: Request, res: Response): Promise<void> => {
  const actor = req.user!;

  const where: Prisma.TicketWhereInput = {
    archivedAt: req.query.archived === 'true' ? undefined : null,
    OR: [{ assigneeId: actor.userId }, { collaborators: { some: { agentId: actor.userId } } }],
  };

  const [items, total] = await Promise.all([
    prisma.ticket.findMany({ where, include: listInclude, orderBy: { createdAt: 'desc' } }),
    prisma.ticket.count({ where }),
  ]);

  res.json({ items: items.map(toListItem), total });
});

// --- Read one ----------------------------------------------------------------

// Express 5 types params as string | string[]; naming the shape keeps `id` a string.
type TicketParams = { id: string };

router.get('/:id', requireTicketAccess, async (req: Request<TicketParams>, res: Response): Promise<void> => {
  const payload = await ticketPayload(req.params.id, req.user!.role);

  if (!payload) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }

  res.json(payload);
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

  res.json((await ticketPayload(req.params.id, req.user!.role))!);
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

  res.json((await ticketPayload(ticket.id, actor.role))!);
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

  res.json((await ticketPayload(ticket.id, actor.role))!);
});

export { router as ticketsRouter };
