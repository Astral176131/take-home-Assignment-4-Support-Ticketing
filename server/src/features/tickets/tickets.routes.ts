import { Router, Request, Response } from 'express';
import { Category, Prisma, Priority } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { authenticate, requireTicketAccess } from '../../middleware/auth.js';
import { writeEvent } from './events.js';
import { STATUS_TO_API, ticketPayload } from './detail.js';
import { computeSla } from './sla.js';
import { ticketKey } from './key.js';
import { buildTicketWhere, resolveTicketSort, resolvePagination, wantsBreachingOnly } from './query.js';
import { ConcurrentChange, guardedUpdate, isConcurrentChange } from './concurrency.js';
import { LIMITS, readEmail, readText } from './validation.js';

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
      ackedAt: ticket.ackedAt,
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

  const subjectText = readText(subject, 'subject', LIMITS.subject);
  if (!subjectText.ok) {
    res.status(400).json({ error: subjectText.error });
    return;
  }
  const descriptionText = readText(description, 'description', LIMITS.description);
  if (!descriptionText.ok) {
    res.status(400).json({ error: descriptionText.error });
    return;
  }
  if (!requester || typeof requester !== 'object') {
    res.status(400).json({ error: 'A requester name is required' });
    return;
  }
  const requesterName = readText(requester.name, 'requester name', LIMITS.requesterName);
  if (!requesterName.ok) {
    res.status(400).json({ error: requesterName.error });
    return;
  }
  const requesterEmail = readEmail(requester.email, 'requester email');
  if (!requesterEmail.ok) {
    res.status(400).json({ error: requesterEmail.error });
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
  const requesterRecord = await findOrCreateRequester(requesterName.value, requesterEmail.value);

  const ticketId = await prisma.$transaction(async (tx) => {
    const created = await tx.ticket.create({
      data: {
        subject: subjectText.value,
        description: descriptionText.value,
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
/**
 * One paged read, shared by the queue and by /mine so the two cannot drift apart in what
 * a filter means or how a page is counted.
 *
 * The breaching filter takes the slower path deliberately: it is the one condition that
 * is computed rather than stored (see wantsBreachingOnly), so those rows have to be read
 * before they can be filtered, and the page is then cut from what survives. Everything
 * else still pages in the database.
 */
async function pagedTickets(
  where: Prisma.TicketWhereInput,
  orderBy: Prisma.TicketOrderByWithRelationInput,
  query: Request['query']
) {
  const { page, pageSize, skip } = resolvePagination(query);

  if (wantsBreachingOnly(query)) {
    const rows = await prisma.ticket.findMany({ where, include: listInclude, orderBy });
    const breaching = rows.map(toListItem).filter((t) => t.sla.breached);
    return {
      items: breaching.slice(skip, skip + pageSize),
      total: breaching.length,
      page,
      page_size: pageSize,
    };
  }

  const [items, total] = await Promise.all([
    prisma.ticket.findMany({ where, include: listInclude, orderBy, skip, take: pageSize }),
    prisma.ticket.count({ where }),
  ]);

  return { items: items.map(toListItem), total, page, page_size: pageSize };
}

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

  res.json(await pagedTickets(where.value, orderBy.value, req.query));
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

  // The same filters, sort and paging as the queue, so the two lists behave identically
  // and there is one definition of what `status=open` or `breaching=true` means.
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

  // ANDed on top rather than passed through the builder: buildTicketWhere narrows an
  // agent to their own work already, but a supervisor it deliberately does not, and this
  // list is "what I hold" for both roles.
  const mine: Prisma.TicketWhereInput = {
    AND: [
      where.value,
      { OR: [{ assigneeId: actor.userId }, { collaborators: { some: { agentId: actor.userId } } }] },
    ],
  };

  res.json(await pagedTickets(mine, orderBy.value, req.query));
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
    const next = readText(subject, 'subject', LIMITS.subject);
    if (!next.ok) {
      res.status(400).json({ error: next.error });
      return;
    }
    data.subject = next.value;
  }
  if (description !== undefined) {
    const next = readText(description, 'description', LIMITS.description);
    if (!next.ok) {
      res.status(400).json({ error: next.error });
      return;
    }
    data.description = next.value;
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
  // An archived ticket is frozen, the same way it is for status changes, replies and
  // reassignment. This route was the one mutation that let an edit through — and since
  // field edits write no history row, an archived ticket's subject could have been
  // rewritten leaving nothing on the timeline to say so.
  if (existing.archivedAt) {
    res.status(409).json({ error: 'This ticket is archived — restore it before editing it' });
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

  // Conditional on it still being unarchived: two archive requests at once would otherwise
  // both succeed and write two `archived` rows into a timeline that, by database trigger,
  // can never be corrected.
  try {
    await prisma.$transaction(async (tx) => {
      const won = await guardedUpdate(tx, { id: ticket.id, archivedAt: null }, { archivedAt: new Date() });
      if (!won) throw new ConcurrentChange('This ticket is already archived');

      await writeEvent(tx, { ticketId: ticket.id, eventType: 'archived', actorId: actor.userId });
    });
  } catch (err) {
    if (isConcurrentChange(err)) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }

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

  try {
    await prisma.$transaction(async (tx) => {
      const won = await guardedUpdate(tx, { id: ticket.id, archivedAt: { not: null } }, { archivedAt: null });
      if (!won) throw new ConcurrentChange('This ticket is not archived');

      await writeEvent(tx, { ticketId: ticket.id, eventType: 'restored', actorId: actor.userId });
    });
  } catch (err) {
    if (isConcurrentChange(err)) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }

  res.json((await ticketPayload(ticket.id, actor.role))!);
});

export { router as ticketsRouter };
