import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { TicketTable } from '../components/TicketTable';
import { TicketFilters } from '../components/TicketFilters';
import { Pagination } from '../components/Pagination';
import { usePageMeta } from '../lib/usePageMeta';
import { PAGE_SIZE, useTicketQuery } from '../lib/useTicketQuery';
import type { Paged, TicketListItem } from '../types';

/**
 * Goal 5's "one list of every ticket where they are the primary assignee or a
 * collaborator". For a supervisor this is narrower than the queue rather than wider: it
 * shows only what they hold personally, which means escalations they have taken on.
 *
 * It offers the same search, filters, sorting and paging as the queue, against the same
 * endpoint contract, so moving between the two lists does not mean learning two sets of
 * controls. There is no assignee filter, because every ticket here is already yours.
 */
export function MyTicketsPage() {
  const [tickets, setTickets] = useState<TicketListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  usePageMeta(
    'My tickets',
    'Every ticket where you are the primary assignee or a collaborator, gathered into one list, with the status, priority and remaining response time for each.'
  );

  const query = useTicketQuery();
  const { queryString, page, sort, dir, setParam, toggleSort, hasFilters, clearFilters } = query;

  useEffect(() => {
    setLoading(true);
    api
      .get<Paged<TicketListItem>>(`/api/tickets/mine?${queryString}`)
      .then((data) => {
        setTickets(data.items);
        setTotal(data.total);
        setError('');
      })
      .catch((err) =>
        setError(
          err instanceof ApiError
            ? `Your tickets could not be loaded. ${err.message}`
            : 'Your tickets could not be loaded. Check your connection, then reload the page.'
        )
      )
      .finally(() => setLoading(false));
  }, [queryString]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>My tickets</h2>
        </div>
      </header>

      <TicketFilters query={query} />

      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <>
          <div className="skeleton-list" aria-hidden="true">
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
          <p className="sr-only" role="status">
            Loading your tickets
          </p>
        </>
      ) : tickets.length === 0 ? (
        <div className="empty-state">
          <h3>{hasFilters ? 'Nothing here matches these filters' : 'Nothing is on your plate right now'}</h3>
          <p>
            {hasFilters
              ? 'Widen the search, or clear the filters to see everything you hold.'
              : 'Pick something up from the queue, or log a request that has just come in by email or phone.'}
          </p>
          <div className="page-actions">
            {hasFilters && (
              <button type="button" className="btn" onClick={clearFilters}>
                Clear filters
              </button>
            )}
            <Link className="btn btn-primary" to="/tickets">
              Browse the queue
            </Link>
            <Link className="btn" to="/tickets/new">
              New ticket
            </Link>
          </div>
        </div>
      ) : (
        <>
          <TicketTable tickets={tickets} sort={sort} dir={dir} onSort={toggleSort} />

          <Pagination
            page={page}
            totalPages={totalPages}
            total={total}
            onPage={(next) => setParam('page', String(next), false)}
          />
        </>
      )}
    </div>
  );
}
