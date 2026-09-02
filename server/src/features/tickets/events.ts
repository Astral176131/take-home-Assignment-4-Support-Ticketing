import { EventType, Prisma } from '@prisma/client';

/**
 * Append one row to a ticket's history.
 *
 * Always takes a transaction client rather than the shared prisma instance: the brief
 * requires that a ticket can never change without the matching history row, so the
 * caller is forced to write both inside the same transaction or neither.
 *
 * There is deliberately no update or delete counterpart — ticket_events is append-only.
 */
export function writeEvent(
  tx: Prisma.TransactionClient,
  event: {
    ticketId: string;
    eventType: EventType;
    actorId: string | null;
    oldValue?: string | null;
    newValue?: string | null;
  }
) {
  return tx.ticketEvent.create({
    data: {
      ticketId: event.ticketId,
      eventType: event.eventType,
      actorId: event.actorId,
      oldValue: event.oldValue ?? null,
      newValue: event.newValue ?? null,
    },
  });
}
