import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { TicketTable } from '../components/TicketTable';
import { useAuth } from '../context/AuthContext';
import type { Paged, TicketListItem } from '../types';

/**
 * Goal 5's "one list of every ticket where they are the primary assignee or a
 * collaborator". For a supervisor this is narrower than the queue rather than wider: it
 * shows only what they hold personally, which means escalations they have taken on.
 */
export function MyTicketsPage() {
  const { user } = useAuth();
  const [tickets, setTickets] = useState<TicketListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<Paged<TicketListItem>>('/api/tickets/mine')
      .then((data) => {
        setTickets(data.items);
        setTotal(data.total);
        setError('');
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load your tickets'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>My tickets</h2>
          <p className="page-subtitle">
            {user?.role === 'supervisor'
              ? 'Tickets you hold yourself, rather than the whole queue'
              : 'Tickets assigned to you, and tickets you are collaborating on'}
          </p>
        </div>
      </header>

      {error && <div className="error-message">{error}</div>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : tickets.length === 0 ? (
        <div className="empty-state">
          <p>Nothing is on your plate right now.</p>
          <Link className="btn" to="/tickets">
            Browse the queue
          </Link>
        </div>
      ) : (
        <>
          <TicketTable tickets={tickets} />
          <p className="muted table-total">
            {total} ticket{total === 1 ? '' : 's'}
          </p>
        </>
      )}
    </div>
  );
}
