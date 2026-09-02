/**
 * Minutes a ticket spent parked in `pending`, to be credited back to its SLA clock.
 *
 * `Pending` means the ticket is waiting on the customer, and the brief is explicit that
 * the clock does not run against the agent during that time. So on leaving pending, the
 * time since `pending_since` is added to `paused_minutes`.
 *
 * Rounded to the nearest minute because `paused_minutes` is a whole-minute counter.
 * A negative interval (a clock skew, or a `pending_since` in the future) credits nothing
 * rather than stealing time from the pause total.
 */
export function pauseCreditMinutes(pendingSince: Date, now: Date = new Date()): number {
  const elapsedMs = now.getTime() - pendingSince.getTime();
  if (elapsedMs <= 0) return 0;
  return Math.round(elapsedMs / 60_000);
}
