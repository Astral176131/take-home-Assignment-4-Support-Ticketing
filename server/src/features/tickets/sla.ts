import { TicketStatus } from '@prisma/client';
import { WARNING_WINDOW_MINUTES } from '../../lib/config.js';

export interface SlaInput {
  status: TicketStatus;
  clockStartedAt: Date;
  pausedMinutes: number;
  pendingSince: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  targetResponseMinutes: number;
  ackCycle: number;
  ackedThroughCycle: number | null;
}

export interface SlaResult {
  elapsed_minutes: number;
  target_minutes: number;
  remaining_minutes: number;
  breached: boolean;
  warning: boolean;
  alert_active: boolean;
}

/**
 * The moment the clock is reading, which is not always "now".
 *
 * While a ticket waits on the customer the clock does not advance at all, so it reads as
 * of the moment pending began. Once the work is finished the clock stops for good, at the
 * time it was resolved or closed. These key off the current status rather than off the
 * timestamps existing, because resolved_at and closed_at are kept as historical markers
 * and survive a reopen.
 */
function clockReadsAt(t: SlaInput, now: Date): Date {
  if (t.status === 'pending' && t.pendingSince) return t.pendingSince;
  if (t.status === 'resolved' && t.resolvedAt) return t.resolvedAt;
  if (t.status === 'closed' && t.closedAt) return t.closedAt;
  return now;
}

/**
 * Where a ticket stands against the response time its priority promises.
 *
 * `alert_active` is the piece worth reading twice: an acknowledgement only silences the
 * cycle it was made in. Reopening a closed ticket increments `ack_cycle`, which leaves
 * `acked_through_cycle` behind and lets the alert fire again. A ticket that has never
 * been acknowledged has a null `acked_through_cycle`, treated as -1 so that it counts as
 * unacknowledged against cycle 0.
 */
export function computeSla(t: SlaInput, now: Date = new Date()): SlaResult {
  const readsAt = clockReadsAt(t, now);
  const grossMinutes = Math.max(0, Math.round((readsAt.getTime() - t.clockStartedAt.getTime()) / 60_000));
  const elapsed = Math.max(0, grossMinutes - t.pausedMinutes);

  const breached = elapsed > t.targetResponseMinutes;
  const remaining = t.targetResponseMinutes - elapsed;
  const warning = !breached && remaining < WARNING_WINDOW_MINUTES;
  const acknowledged = (t.ackedThroughCycle ?? -1) >= t.ackCycle;

  return {
    elapsed_minutes: elapsed,
    target_minutes: t.targetResponseMinutes,
    remaining_minutes: remaining,
    breached,
    warning,
    alert_active: (breached || warning) && !acknowledged,
  };
}
