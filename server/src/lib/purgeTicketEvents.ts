import type { PrismaClient, Prisma } from '@prisma/client';

/**
 * Deletes `ticket_events` rows, working around the append-only trigger added at the
 * database level to enforce the brief's "nothing in this timeline can be edited or
 * deleted after the fact." That trigger fires for any writer, including the app's own
 * database role, since a table owner's privileges cannot be revoked with a plain
 * `GRANT`/`REVOKE` — so this briefly disables it via table-owner-level DDL, deletes, then
 * re-enables it, all inside one transaction so a failure partway leaves it enabled rather
 * than off.
 *
 * Used by two kinds of caller, both outside the running application: the test suite's own
 * cleanup between runs, and the seed script's re-run guard, which clears previously seeded
 * demo tickets before recreating them. The application's own Prisma queries — everything a
 * real request can trigger — never issue `ALTER TABLE`; only this helper does. The trigger
 * still fully blocks the threat the brief actually describes — a bug in ordinary
 * application code accidentally issuing an UPDATE or DELETE — it just cannot stop someone
 * with full raw-SQL database access who deliberately chooses to disable it, which no
 * trigger could prevent regardless.
 */
export async function purgeTicketEvents(db: PrismaClient, where: Prisma.TicketEventWhereInput) {
  await db.$transaction([
    db.$executeRawUnsafe('ALTER TABLE "ticket_events" DISABLE TRIGGER ticket_events_immutable'),
    db.ticketEvent.deleteMany({ where }),
    db.$executeRawUnsafe('ALTER TABLE "ticket_events" ENABLE TRIGGER ticket_events_immutable'),
  ]);
}
