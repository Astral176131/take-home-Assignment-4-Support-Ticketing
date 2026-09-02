import type { Ticket, TicketStatus } from '../types';

/**
 * The label depends on where the ticket is coming from as much as where it's going:
 * moving to `open` is "Open" from new, "Resume" from pending, and "Reopen" from a ticket
 * that had been finished.
 */
function label(from: TicketStatus, to: TicketStatus): string {
  if (to === 'open') {
    if (from === 'new') return 'Open';
    if (from === 'pending') return 'Resume';
    return 'Reopen';
  }
  if (to === 'pending') return 'Waiting on customer';
  if (to === 'resolved') return 'Resolve';
  return 'Close';
}

interface Props {
  ticket: Ticket;
  busy: boolean;
  onChange: (status: TicketStatus) => void;
}

/**
 * Renders one button per move the server says is currently legal. There are no rules
 * here: an agent simply never receives `closed` in allowed_transitions, and once a
 * reopen window lapses the list arrives empty and the buttons disappear on their own.
 */
export function StatusActions({ ticket, busy, onChange }: Props) {
  if (ticket.allowed_transitions.length === 0) {
    return <p className="muted">No status changes are available.</p>;
  }

  return (
    <div className="status-actions">
      {ticket.allowed_transitions.map((to) => (
        <button
          key={to}
          className={`btn${to === 'resolved' ? ' btn-primary' : ''}`}
          disabled={busy}
          onClick={() => onChange(to)}
        >
          {label(ticket.status, to)}
        </button>
      ))}
    </div>
  );
}
