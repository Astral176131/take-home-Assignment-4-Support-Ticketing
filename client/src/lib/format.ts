/** Small display helpers, shared by the queue and the ticket page. */

/** "2h ago", "3d ago" — enough precision for a support queue, no date library needed. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  // An unparseable timestamp otherwise renders the literal text "Invalid Date" into the
  // page, which reads as a broken record rather than as missing information.
  if (Number.isNaN(then.getTime())) return 'unknown';

  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);

  // A timestamp in the future is clock skew between the browser and the server, not
  // something the reader can act on — "just now" is the honest rendering, and saying
  // "-3m ago" would not be.
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;

  return new Date(iso).toLocaleDateString();
}

/** Turns a minute count into "4h 20m", for SLA figures that can run into days. */
export function duration(minutes: number): string {
  const abs = Math.abs(minutes);
  const days = Math.floor(abs / 1440);
  const hours = Math.floor((abs % 1440) / 60);
  const mins = abs % 60;

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins || parts.length === 0) parts.push(`${mins}m`);

  return parts.join(' ');
}

const CATEGORY_LABELS: Record<string, string> = {
  bug: 'Bug',
  billing: 'Billing',
  how_to: 'How-to',
  other: 'Other',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}
