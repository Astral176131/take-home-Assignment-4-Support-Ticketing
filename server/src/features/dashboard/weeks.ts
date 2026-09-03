/**
 * Calendar-week bucketing, UTC, weeks starting Monday — matching Postgres's own
 * `date_trunc('week', ...)`, which the dashboard query uses to group resolutions. Kept
 * separate and pure so the boundary math is testable without a database.
 */

/** Monday 00:00 UTC of the week containing `date`. */
export function startOfWeekUtc(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return d;
}

/** The start of each of the last `n` calendar weeks, oldest first, ending with the
 *  current (possibly partial) week. */
export function lastNWeekStarts(n: number, now: Date = new Date()): Date[] {
  const current = startOfWeekUtc(now);
  const starts: Date[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(current);
    d.setUTCDate(d.getUTCDate() - i * 7);
    starts.push(d);
  }
  return starts;
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
