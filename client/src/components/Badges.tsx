import type { Priority, Sla, TicketStatus } from '../types';
import { duration } from '../lib/format';

const STATUS_LABELS: Record<TicketStatus, string> = {
  new: 'New',
  open: 'Open',
  pending: 'Pending',
  resolved: 'Resolved',
  closed: 'Closed',
};

export function StatusBadge({ status }: { status: TicketStatus }) {
  return <span className={`chip chip-status chip-status-${status}`}>{STATUS_LABELS[status]}</span>;
}

const PRIORITY_LABELS: Record<Priority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span className={`chip chip-priority chip-priority-${priority}`}>
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

/**
 * How far a ticket has run against its response target, drawn as a runway that
 * fills as the clock does.
 *
 * This is the one element on the page given real visual weight, because it is
 * the one question the product exists to answer: the brief asks that anyone be
 * able to see what is about to breach "without scanning every open ticket by
 * hand". As a pill it sat among three other pills in the row and read as just
 * another field. As a bar it makes a column of risk scannable as a shape.
 *
 * Breach and warning are decided server-side; this only picks how to say it.
 * The state is in the text as well as the colour, so it never depends on hue.
 */
export function SlaGauge({ sla, lead = false }: { sla: Sla; lead?: boolean }) {
  const tone = sla.breached ? 'breached' : sla.warning ? 'warning' : 'ok';

  const text = sla.breached
    ? `Breached by ${duration(-sla.remaining_minutes)}`
    : `${duration(sla.remaining_minutes)} left`;

  // Elapsed against target, clamped. A breached ticket shows a full runway
  // rather than one that overflows its own track.
  const fraction = sla.target_minutes > 0
    ? Math.min(1, Math.max(0.02, sla.elapsed_minutes / sla.target_minutes))
    : 1;

  const title = sla.breached
    ? 'Past its response target'
    : sla.warning
      ? 'Close to its response target'
      : 'Within its response target';

  return (
    <div className={`sla sla-${tone}${lead ? ' sla-lead' : ''}`} title={title}>
      <span className="sla-track" aria-hidden="true">
        <span className="sla-fill" style={{ transform: `scaleX(${sla.breached ? 1 : fraction})` }} />
      </span>
      <span className="sla-text">{text}</span>
    </div>
  );
}
