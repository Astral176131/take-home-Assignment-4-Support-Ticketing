/**
 * Every route that changes a ticket reads it, decides whether the change is legal, then
 * writes. Those are two separate statements, and between them another request can change
 * the same row — so the decision can be made against a ticket that no longer exists in
 * that state by the time the write lands.
 *
 * The fix is to make the precondition part of the write itself: `updateMany` with the
 * expected state in its `where`, inside the transaction. Postgres re-evaluates that `where`
 * after taking the row lock, so the second writer matches zero rows rather than applying a
 * change the state machine already ruled out. `guardedUpdate` returns whether it won.
 *
 * This matters more than the usual "two clicks" hand-waving: a status change that slips
 * through writes a `ticket_events` row, and those are append-only by database trigger. A
 * duplicate there cannot be cleaned up afterwards.
 */

import { Prisma } from '@prisma/client';

/**
 * Apply `data` to a ticket only if it still matches `where`. Returns true if this caller
 * made the change, false if another request got there first.
 *
 * The caller must write its `ticket_events` row only when this returns true — that is the
 * whole point, so history records changes that actually happened, once each.
 */
export async function guardedUpdate(
  tx: Prisma.TransactionClient,
  where: Prisma.TicketWhereInput,
  // The "unchecked" variant is the one that includes relation scalars like `assignee_id`;
  // the checked variant covers only plain columns, and reassignment needs the former.
  data: Prisma.TicketUpdateManyMutationInput | Prisma.TicketUncheckedUpdateManyInput
): Promise<boolean> {
  const { count } = await tx.ticket.updateMany({ where, data });
  return count > 0;
}

/**
 * Thrown inside a transaction when `guardedUpdate` lost, to roll back whatever the
 * transaction had already done. Routes catch it and answer 409 — the same code an illegal
 * transition gets, because that is what it is: the request conflicts with the ticket's
 * state, it just became true a few milliseconds ago rather than before the request began.
 */
export class ConcurrentChange extends Error {
  constructor(message = 'This ticket changed while your request was being processed — reload it and try again') {
    super(message);
    this.name = 'ConcurrentChange';
  }
}

export function isConcurrentChange(err: unknown): err is ConcurrentChange {
  return err instanceof ConcurrentChange;
}
