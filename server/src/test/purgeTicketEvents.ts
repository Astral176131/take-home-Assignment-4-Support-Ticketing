import type { PrismaClient, Prisma } from '@prisma/client';

/**
 * Deletes `ticket_events` rows in test cleanup only, working around the append-only
 * trigger added at the database level to enforce the brief's "nothing in this timeline
 * can be edited or deleted after the fact." That trigger fires for any writer, including
 * the app's own database role, since a table owner's privileges cannot be revoked with a
 * plain `GRANT`/`REVOKE` — so tests, which must actually remove their fixtures between
 * runs to stay isolated, briefly disable it via table-owner-level DDL, delete, then
 * re-enable it, all inside one transaction so a failure partway leaves it enabled rather
 * than off.
 *
 * The application's own Prisma queries never issue `ALTER TABLE`; only this test helper
 * does. The trigger still fully blocks the threat the brief actually describes — a bug in
 * ordinary application code accidentally issuing an UPDATE or DELETE — it just cannot stop
 * someone with full raw-SQL database access who deliberately chooses to disable it, which
 * no trigger could prevent regardless.
 */
export async function purgeTicketEvents(db: PrismaClient, where: Prisma.TicketEventWhereInput) {
  await db.$transaction([
    db.$executeRawUnsafe('ALTER TABLE "ticket_events" DISABLE TRIGGER ticket_events_immutable'),
    db.ticketEvent.deleteMany({ where }),
    db.$executeRawUnsafe('ALTER TABLE "ticket_events" ENABLE TRIGGER ticket_events_immutable'),
  ]);
}
