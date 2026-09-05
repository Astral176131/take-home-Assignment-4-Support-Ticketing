/**
 * Tunable rules from the brief, in one place so they can be explained and adjusted
 * without hunting through route code. Both are overridable by environment variable,
 * which is also what lets tests drive the boundaries without waiting real days.
 */

/** How long after being closed a ticket may still be reopened. */
export const REOPEN_WINDOW_DAYS = Number(process.env.REOPEN_WINDOW_DAYS ?? 7);

/** How close to its target a ticket must be before it counts as about to breach. */
export const WARNING_WINDOW_MINUTES = Number(process.env.WARNING_WINDOW_MINUTES ?? 15);

/**
 * How long an acknowledgement silences an alert for.
 *
 * Acknowledging used to silence a ticket for its whole response cycle, which made
 * "acknowledge" a way of making a breach disappear without fixing it. It is now a snooze:
 * the alert comes back when the window is up and the ticket is still unresolved, and can
 * be snoozed again from there.
 */
export const ACK_SNOOZE_MINUTES = Number(process.env.ACK_SNOOZE_MINUTES ?? 60);
