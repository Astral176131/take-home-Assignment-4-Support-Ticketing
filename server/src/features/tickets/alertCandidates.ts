import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { listInclude, toListItem } from './tickets.routes.js';

/**
 * Every non-archived ticket still in progress (new, open or pending — never resolved or
 * closed), in the queue's own row shape, `sla` included. Shared by the dashboard's
 * breaching count and the alerts list, which both start from exactly this set and then
 * differ only in which field of `sla` they filter on: the dashboard counts `breached`
 * (a plain fact about the ticket, regardless of acknowledgement), the alerts list filters
 * on `alert_active` (which also excludes anything already acknowledged this cycle).
 *
 * `scope` narrows the set further — used to restrict an agent to their own tickets — and
 * is ANDed in alongside the in-progress/non-archived condition, never replacing it.
 */
export async function findInProgressTickets(scope?: Prisma.TicketWhereInput) {
  const tickets = await prisma.ticket.findMany({
    where: {
      archivedAt: null,
      status: { in: ['new_ticket', 'open', 'pending'] },
      ...scope,
    },
    include: listInclude,
  });

  return tickets.map(toListItem);
}
