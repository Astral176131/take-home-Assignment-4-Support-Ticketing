/**
 * A ticket's human-readable label, e.g. "SUP-14". Used everywhere `number` needs to
 * become the string shown to a person — the queue, the ticket page and the CSV export
 * all go through this one function.
 */
export function ticketKey(number: number): string {
  return `SUP-${number}`;
}
