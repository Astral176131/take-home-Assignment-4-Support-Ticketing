import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { findInProgressTickets } from '../tickets/alertCandidates.js';
import { API_STATUSES, STATUS_TO_API } from '../tickets/stateMachine.js';
import { isoDate, lastNWeekStarts, startOfWeekUtc } from './weeks.js';

const router = Router();

router.use(authenticate);

const WEEKS = 8;

/**
 * GET /api/dashboard
 *
 * One shared dashboard: neither the brief nor the build prompt scopes this by role, so
 * every authenticated user sees the same numbers — unlike the queue, which is agent- or
 * supervisor-scoped throughout the rest of the app.
 *
 * Everything that can be a `GROUP BY` is one — status and per-agent counts are Prisma's
 * native groupBy, and the 8-week series is a single grouped query keyed by
 * `date_trunc('week', resolved_at)`, since Prisma's typed groupBy has no way to express
 * that computed key. The one count that genuinely can't be a database aggregate is
 * "breaching": breach depends on the same clock logic the ticket page uses
 * (`computeSla`), which the database doesn't know about, so it's evaluated over the small,
 * bounded set of tickets still in progress rather than the whole table.
 *
 * Resolved-related numbers exclude tickets whose current status has moved past resolved
 * (i.e. closed) only in the sense that "resolved this week" reads `resolved_at`
 * regardless of what happened afterwards — resolving is an activity that already occurred,
 * and closing it later doesn't undo that it happened. Breach and alert consideration,
 * separately, excludes anything already resolved or closed: there is nothing left to act
 * on once a ticket's response has already happened.
 */
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  const weekStarts = lastNWeekStarts(WEEKS);

  // Issued together rather than one after another. They do not depend on each other, and
  // this is the landing page — run sequentially against a hosted database each one pays
  // its own round trip, which was most of the endpoint's response time.
  const [statusCounts, agentCounts, weekRows, inProgress, unassignedCount] = await Promise.all([
    prisma.ticket.groupBy({
      by: ['status'],
      where: { archivedAt: null },
      _count: true,
    }),
    prisma.ticket.groupBy({
      by: ['assigneeId'],
      where: { archivedAt: null, assigneeId: { not: null } },
      _count: true,
    }),
    prisma.$queryRaw<Array<{ week_start: Date; count: bigint }>>(Prisma.sql`
      SELECT date_trunc('week', resolved_at) AS week_start, COUNT(*)::bigint AS count
      FROM tickets
      WHERE resolved_at >= ${weekStarts[0]} AND archived_at IS NULL
      GROUP BY week_start
      ORDER BY week_start
    `),
    // Breach only means something for a ticket still in progress — resolved and closed
    // tickets already got their response, so they are excluded here even though they may
    // still show breached: true if asked directly (that history is intentionally preserved
    // on the ticket itself; it just isn't what "currently breaching" means on a dashboard).
    findInProgressTickets(),
    prisma.ticket.count({ where: { archivedAt: null, assigneeId: null } }),
  ]);

  const byStatus: Record<string, number> = Object.fromEntries(API_STATUSES.map((s) => [s, 0]));
  for (const row of statusCounts) {
    byStatus[STATUS_TO_API[row.status]] = row._count;
  }

  const agentIds = agentCounts.map((r) => r.assigneeId as string);
  const agents = await prisma.user.findMany({
    where: { id: { in: agentIds } },
    select: { id: true, name: true },
  });
  const agentNames = new Map(agents.map((a) => [a.id, a.name]));
  const byAgent = agentCounts
    .map((row) => ({
      agent: { id: row.assigneeId as string, name: agentNames.get(row.assigneeId as string) ?? '' },
      count: row._count,
    }))
    .sort((a, b) => b.count - a.count);

  const weekCounts = new Map(weekRows.map((r) => [isoDate(r.week_start), Number(r.count)]));
  const resolvedPerWeek = weekStarts.map((start) => ({
    week_start: isoDate(start),
    count: weekCounts.get(isoDate(start)) ?? 0,
  }));
  // The most recent bucket *is* "resolved this week" — computed once, so the headline
  // number and the chart's last bar can never disagree.
  const resolvedThisWeek = resolvedPerWeek[resolvedPerWeek.length - 1].count;

  // `breached` is a plain fact about the ticket, independent of acknowledgement — a
  // supervisor's count should not go quiet just because an agent silenced their own alert.
  const breachingCount = inProgress.filter((t) => t.sla.breached).length;

  res.json({
    open_count: byStatus.open,
    pending_count: byStatus.pending,
    resolved_this_week: resolvedThisWeek,
    breaching_count: breachingCount,
    unassigned_count: unassignedCount,
    by_status: byStatus,
    by_agent: byAgent,
    resolved_per_week: resolvedPerWeek,
  });
});

/**
 * GET /api/dashboard/week?start=YYYY-MM-DD
 *
 * The drill-down behind clicking one bar of the 8-week chart: the same week, broken down
 * by day (Monday through Sunday) and by who resolved what. `start` is floored to that
 * week's Monday regardless of which day within the week is actually passed, so the link
 * the client builds from a bar's own week_start always lands on the right week without
 * the two ends having to agree on exactly what "the start" means bit for bit.
 */
router.get('/week', async (req: Request, res: Response): Promise<void> => {
  const raw = req.query.start;
  if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) {
    res.status(400).json({ error: 'start must be a valid date' });
    return;
  }

  const weekStart = startOfWeekUtc(new Date(raw));
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

  const [dayRows, agentCounts] = await Promise.all([
    prisma.$queryRaw<Array<{ day: Date; count: bigint }>>(Prisma.sql`
      SELECT date_trunc('day', resolved_at) AS day, COUNT(*)::bigint AS count
      FROM tickets
      WHERE resolved_at >= ${weekStart} AND resolved_at < ${weekEnd} AND archived_at IS NULL
      GROUP BY day
      ORDER BY day
    `),
    prisma.ticket.groupBy({
      by: ['assigneeId'],
      where: {
        archivedAt: null,
        assigneeId: { not: null },
        resolvedAt: { gte: weekStart, lt: weekEnd },
      },
      _count: true,
    }),
  ]);

  const dayCounts = new Map(dayRows.map((r) => [isoDate(r.day), Number(r.count)]));
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setUTCDate(d.getUTCDate() + i);
    return { date: isoDate(d), count: dayCounts.get(isoDate(d)) ?? 0 };
  });

  const agentIds = agentCounts.map((r) => r.assigneeId as string);
  const agents = await prisma.user.findMany({
    where: { id: { in: agentIds } },
    select: { id: true, name: true },
  });
  const agentNames = new Map(agents.map((a) => [a.id, a.name]));
  const byAgent = agentCounts
    .map((row) => ({
      agent: { id: row.assigneeId as string, name: agentNames.get(row.assigneeId as string) ?? '' },
      count: row._count,
    }))
    .sort((a, b) => b.count - a.count);

  res.json({ week_start: isoDate(weekStart), days, by_agent: byAgent });
});

export { router as dashboardRouter };
