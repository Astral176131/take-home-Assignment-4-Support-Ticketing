import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { buildTicketWhere, resolveTicketSort } from './query.js';
import { STATUS_TO_API } from './stateMachine.js';
import { computeSla } from './sla.js';
import { ticketKey } from './key.js';
import { csvRow } from './csv.js';

const router = Router();

router.use(authenticate);

const exportInclude = {
  requester: true,
  priority: true,
  assignee: { select: { name: true } },
} satisfies Prisma.TicketInclude;

const COLUMNS = [
  'key',
  'subject',
  'status',
  'priority',
  'category',
  'requester_name',
  'requester_email',
  'assignee',
  'created_at',
  'updated_at',
  'breached',
];

const BATCH_SIZE = 500;

/**
 * GET /api/tickets/export.csv
 *
 * Same filters as the queue list — built by the identical `buildTicketWhere` /
 * `resolveTicketSort` functions, so the two cannot drift apart — but with no page limit:
 * exporting one page of a filtered set would defeat the point of an export.
 *
 * Streamed rather than collected into an array first, so memory stays flat regardless of
 * how many rows match. `breached` is computed with the same `computeSla` the queue and
 * ticket page use, so the export can never disagree with what is shown on screen for the
 * same ticket at the same moment.
 */
router.get('/export.csv', async (req: Request, res: Response): Promise<void> => {
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

  const filename = `tickets-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  res.write(csvRow(COLUMNS));

  let skip = 0;
  for (;;) {
    const batch = await prisma.ticket.findMany({
      where: where.value,
      include: exportInclude,
      orderBy: orderBy.value,
      skip,
      take: BATCH_SIZE,
    });

    if (batch.length === 0) break;

    for (const ticket of batch) {
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

      res.write(
        csvRow([
          ticketKey(ticket.number),
          ticket.subject,
          STATUS_TO_API[ticket.status],
          ticket.priorityCode,
          ticket.category,
          ticket.requester.name,
          ticket.requester.email,
          ticket.assignee?.name ?? '',
          ticket.createdAt.toISOString(),
          ticket.updatedAt.toISOString(),
          sla.breached ? 'yes' : 'no',
        ])
      );
    }

    skip += BATCH_SIZE;
    if (batch.length < BATCH_SIZE) break;
  }

  res.end();
});

export { router as exportRouter };
