import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { timeAgo, categoryLabel } from '../lib/format';
import { PriorityBadge, SlaBadge, StatusBadge } from '../components/Badges';
import { useAuth } from '../context/AuthContext';
import type { Paged, TicketListItem } from '../types';

export function QueuePage() {
  const { user } = useAuth();
  const [tickets, setTickets] = useState<TicketListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .get<Paged<TicketListItem>>(`/api/tickets${showArchived ? '?archived=true' : ''}`)
      .then((data) => {
        setTickets(data.items);
        setTotal(data.total);
        setError('');
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load tickets'))
      .finally(() => setLoading(false));
  }, [showArchived]);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Queue</h2>
          <p className="page-subtitle">
            {/* Scoping is enforced server-side; this only explains what you are seeing. */}
            {user?.role === 'supervisor'
              ? 'Every ticket in the system'
              : 'Tickets assigned to you or where you are a collaborator'}
          </p>
        </div>
        <div className="page-actions">
          <label className="toggle">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
          <Link className="btn btn-primary" to="/tickets/new">
            New ticket
          </Link>
        </div>
      </header>

      {error && <div className="error-message">{error}</div>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : tickets.length === 0 ? (
        <div className="empty-state">
          <p>No tickets here yet.</p>
          <Link className="btn btn-primary" to="/tickets/new">
            Create the first one
          </Link>
        </div>
      ) : (
        <>
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
          <p className="muted table-total">
            {total} ticket{total === 1 ? '' : 's'}
          </p>
        </>
      )}
    </div>
  );
}
