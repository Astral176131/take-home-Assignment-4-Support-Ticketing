import { Link } from 'react-router-dom';
import { PriorityBadge, SlaBadge, StatusBadge } from './Badges';
import { categoryLabel, timeAgo } from '../lib/format';
import type { TicketListItem } from '../types';

/**
 * The queue table, shared by the full queue and the my-tickets view. Both render the same
 * columns from the same payload shape, so there is one definition of what a ticket row
 * looks like rather than two that drift.
 */
export function TicketTable({ tickets }: { tickets: TicketListItem[] }) {
  return (
    <div className="table-wrap">
      <table className="queue-table">
        <thead>
          <tr>
            <th>Subject</th>
            <th>Status</th>
            <th>Priority</th>
            <th>Category</th>
            <th>Requester</th>
            <th>Assignee</th>
            <th>Response</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((ticket) => (
            <tr key={ticket.id} className={ticket.archived_at ? 'row-archived' : undefined}>
              <td>
                <Link className="ticket-link" to={`/tickets/${ticket.id}`}>
                  {ticket.subject}
                </Link>
                {ticket.archived_at && <span className="chip chip-archived">Archived</span>}
              </td>
              <td>
                <StatusBadge status={ticket.status} />
              </td>
              <td>
                <PriorityBadge priority={ticket.priority_code} />
              </td>
              <td className="muted">{categoryLabel(ticket.category)}</td>
              <td>{ticket.requester.name}</td>
              <td>{ticket.assignee?.name ?? <span className="muted">Unassigned</span>}</td>
              <td>
                <SlaBadge sla={ticket.sla} />
              </td>
              <td className="muted">{timeAgo(ticket.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
