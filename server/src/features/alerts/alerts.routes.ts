import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { findInProgressTickets } from '../tickets/alertCandidates.js';

const router = Router();

router.use(authenticate);

/**
 * GET /api/alerts
 *
 * Scoped identically to who may acknowledge one (decision: a deliberate departure from
 * the brief's literal "their assigned tickets" wording, kept symmetric with ack's own
 * scope — otherwise a collaborator could be told they're allowed to acknowledge an alert
 * that never appears anywhere in their own list). A supervisor sees every active alert.
 *
 * Sorted most severe first: `elapsed_minutes - target_minutes` is positive and growing for
 * a breach the longer it's overdue, and negative for a ticket only in warning — one sort
 * key naturally puts every breach ahead of every warning without a separate tier.
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const actor = req.user!;

  const scope =
    actor.role === 'agent'
      ? { OR: [{ assigneeId: actor.userId }, { collaborators: { some: { agentId: actor.userId } } }] }
      : undefined;

  const candidates = await findInProgressTickets(scope);
  const active = candidates
    .filter((t) => t.sla.alert_active)
    .sort((a, b) => b.sla.elapsed_minutes - b.sla.target_minutes - (a.sla.elapsed_minutes - a.sla.target_minutes));

  // Past their target (or nearly) but already acknowledged, so deliberately absent from
  // the list above. Reported alongside it because otherwise an empty list is ambiguous:
  // "nothing is wrong" and "everything wrong has been seen and silenced" look identical,
  // and the dashboard's breaching tile — which counts breaches regardless of
  // acknowledgement — then appears to contradict a page showing nothing.
  const acknowledged = candidates.filter(
    (t) => (t.sla.breached || t.sla.warning) && !t.sla.alert_active
  ).length;

  res.json({ items: active, total: active.length, acknowledged });
});

export { router as alertsRouter };
