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
 * Where a ticket stands against its response target. Breach and warning are decided
 * server-side; this only picks how to say it.
 */
export function SlaBadge({ sla }: { sla: Sla }) {
  if (sla.breached) {
    return (
      <span className="chip chip-sla chip-sla-breached" title="Past its response target">
        Breached by {duration(-sla.remaining_minutes)}
      </span>
    );
  }

  if (sla.warning) {
    return (
      <span className="chip chip-sla chip-sla-warning" title="Close to its response target">
        {duration(sla.remaining_minutes)} left
      </span>
    );
  }

  return (
    <span className="chip chip-sla chip-sla-ok" title="Within its response target">
      {duration(sla.remaining_minutes)} left
    </span>
  );
}
