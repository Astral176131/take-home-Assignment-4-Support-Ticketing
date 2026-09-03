import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { computeSla } from '../tickets/sla.js';
import { API_STATUSES, STATUS_TO_API } from '../tickets/stateMachine.js';
import { isoDate, lastNWeekStarts } from './weeks.js';

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
  const statusCounts = await prisma.ticket.groupBy({
    by: ['status'],
    where: { archivedAt: null },
    _count: true,
  });

  const byStatus: Record<string, number> = Object.fromEntries(API_STATUSES.map((s) => [s, 0]));
  for (const row of statusCounts) {
    byStatus[STATUS_TO_API[row.status]] = row._count;
  }

  const agentCounts = await prisma.ticket.groupBy({
    by: ['assigneeId'],
    where: { archivedAt: null, assigneeId: { not: null } },
    _count: true,
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

  const weekStarts = lastNWeekStarts(WEEKS);
  const weekRows = await prisma.$queryRaw<Array<{ week_start: Date; count: bigint }>>(Prisma.sql`
    SELECT date_trunc('week', resolved_at) AS week_start, COUNT(*)::bigint AS count
    FROM tickets
    WHERE resolved_at >= ${weekStarts[0]} AND archived_at IS NULL
    GROUP BY week_start
    ORDER BY week_start
  `);
  const weekCounts = new Map(weekRows.map((r) => [isoDate(r.week_start), Number(r.count)]));
  const resolvedPerWeek = weekStarts.map((start) => ({
    week_start: isoDate(start),
    count: weekCounts.get(isoDate(start)) ?? 0,
  }));
  // The most recent bucket *is* "resolved this week" — computed once, so the headline
  // number and the chart's last bar can never disagree.
  const resolvedThisWeek = resolvedPerWeek[resolvedPerWeek.length - 1].count;

  // Breach only means something for a ticket still in progress — resolved and closed
  // tickets already got their response, so they are excluded here even though they may
  // still show breached: true if asked directly (that history is intentionally preserved
  // on the ticket itself; it just isn't what "currently breaching" means on a dashboard).
  const inProgress = await prisma.ticket.findMany({
    where: { archivedAt: null, status: { in: ['new_ticket', 'open', 'pending'] } },
    select: {
      status: true,
      clockStartedAt: true,
      pausedMinutes: true,
      pendingSince: true,
      ackCycle: true,
      ackedThroughCycle: true,
      priority: { select: { targetResponseMinutes: true } },
    },
  });
  const breachingCount = inProgress.filter(
    (t) =>
      computeSla({
        status: t.status,
        clockStartedAt: t.clockStartedAt,
        pausedMinutes: t.pausedMinutes,
        pendingSince: t.pendingSince,
        resolvedAt: null,
        closedAt: null,
        targetResponseMinutes: t.priority.targetResponseMinutes,
        ackCycle: t.ackCycle,
        ackedThroughCycle: t.ackedThroughCycle,
      }).breached
  ).length;

  res.json({
    open_count: byStatus.open,
    pending_count: byStatus.pending,
    resolved_this_week: resolvedThisWeek,
    breaching_count: breachingCount,
    by_status: byStatus,
    by_agent: byAgent,
    resolved_per_week: resolvedPerWeek,
  });
});

export { router as dashboardRouter };
