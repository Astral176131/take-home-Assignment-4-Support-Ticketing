import { TicketStatus } from '@prisma/client';
import { ACK_SNOOZE_MINUTES, WARNING_WINDOW_MINUTES } from '../../lib/config.js';

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
  ackedAt: Date | null;
}

export interface SlaResult {
  elapsed_minutes: number;
  target_minutes: number;
  remaining_minutes: number;
  breached: boolean;
  warning: boolean;
  alert_active: boolean;
  /** Minutes until an acknowledged alert comes back, or null if it is not snoozed. */
  snoozed_for_minutes: number | null;
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
 * `alert_active` is the piece worth reading twice. An acknowledgement silences an alert
 * two ways, and both have to hold for it to stay quiet:
 *
 *   - it must be for the current cycle. Reopening a closed ticket increments `ack_cycle`,
 *     which leaves `acked_through_cycle` behind and lets the alert fire again. A ticket
 *     never acknowledged has a null `acked_through_cycle`, treated as -1 so it counts as
 *     unacknowledged against cycle 0.
 *   - it must be recent. The acknowledgement expires after ACK_SNOOZE_MINUTES, so a
 *     ticket acknowledged and then left alone comes back rather than staying silent for
 *     the rest of its life. A null `acked_at` is an acknowledgement made before that
 *     column existed, which reads as already expired.
 */
export function computeSla(t: SlaInput, now: Date = new Date()): SlaResult {
  const readsAt = clockReadsAt(t, now);
  const grossMinutes = Math.max(0, Math.round((readsAt.getTime() - t.clockStartedAt.getTime()) / 60_000));
  const elapsed = Math.max(0, grossMinutes - t.pausedMinutes);

  const breached = elapsed > t.targetResponseMinutes;
  const remaining = t.targetResponseMinutes - elapsed;
  const warning = !breached && remaining < WARNING_WINDOW_MINUTES;
  const ackedThisCycle = (t.ackedThroughCycle ?? -1) >= t.ackCycle;

  // Measured from `now`, not from the frozen clock: the snooze is about how long ago a
  // person looked at this, which keeps running while the ticket waits on the customer.
  const snoozeAgeMinutes = t.ackedAt
    ? Math.max(0, Math.round((now.getTime() - t.ackedAt.getTime()) / 60_000))
    : null;
  const snoozeLeft =
    ackedThisCycle && snoozeAgeMinutes !== null && snoozeAgeMinutes < ACK_SNOOZE_MINUTES
      ? ACK_SNOOZE_MINUTES - snoozeAgeMinutes
      : null;

  return {
    elapsed_minutes: elapsed,
    target_minutes: t.targetResponseMinutes,
    remaining_minutes: remaining,
    breached,
    warning,
    alert_active: (breached || warning) && snoozeLeft === null,
    snoozed_for_minutes: (breached || warning) ? snoozeLeft : null,
  };
}
