/**
 * Tunable rules from the brief, in one place so they can be explained and adjusted
 * without hunting through route code. Both are overridable by environment variable,
 * which is also what lets tests drive the boundaries without waiting real days.
 */

/** How long after being closed a ticket may still be reopened. */
export const REOPEN_WINDOW_DAYS = Number(process.env.REOPEN_WINDOW_DAYS ?? 7);

/** How close to its target a ticket must be before it counts as about to breach. */
export const WARNING_WINDOW_MINUTES = Number(process.env.WARNING_WINDOW_MINUTES ?? 15);
