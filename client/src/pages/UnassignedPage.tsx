import { Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { TicketTable } from '../components/TicketTable';
import { TicketFilters } from '../components/TicketFilters';
import { Pagination } from '../components/Pagination';
import { BulkActionBar } from '../components/BulkActionBar';
import { useAuth } from '../context/AuthContext';
import { useUnassigned } from '../context/UnassignedContext';
import { usePageMeta } from '../lib/usePageMeta';
import { PAGE_SIZE, useTicketQuery } from '../lib/useTicketQuery';
import type { Paged, TicketListItem } from '../types';

/**
 * Every ticket nobody has picked up yet — a supervisor's page, since routing one to an
 * agent is a supervisor action throughout this system (decision 1). The server already
 * refuses this endpoint to an agent; the redirect below just keeps one from landing on a
 * page that can only ever show them an error.
 *
 * There is no assignee filter, the way there is none on my-tickets: every row here is
 * already unassigned. Everything else — search, status, priority, category, sort, paging,
 * and bulk selection — is the same machinery the queue uses, so acting on this list works
 * exactly the way acting on the queue does.
 */
export function UnassignedPage() {
  const { user } = useAuth();
  const { refresh: refreshUnassigned } = useUnassigned();

  usePageMeta(
    'Unassigned tickets',
    'Every ticket nobody has picked up yet, so it can be routed to an agent before it sits long enough to breach its response target.'
  );

  const query = useTicketQuery();
  const { queryString, page, sort, dir, setParam, toggleSort, hasFilters, clearFilters } = query;

  const [tickets, setTickets] = useState<TicketListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSelected(new Set());
  }, [queryString]);

  function load() {
    setLoading(true);
    return api
      .get<Paged<TicketListItem>>(`/api/tickets/unassigned?${queryString}`)
      .then((data) => {
        setTickets(data.items);
        setTotal(data.total);
        setError('');
      })
      .catch((err) =>
        setError(
          err instanceof ApiError
            ? `Unassigned tickets could not be loaded. ${err.message}`
            : 'Unassigned tickets could not be loaded. Check your connection, then reload the page.'
        )
      )
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, [queryString]);

  function toggleSelect(ticketId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ticketId)) next.delete(ticketId);
      else next.add(ticketId);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      const allSelected = tickets.length > 0 && tickets.every((t) => prev.has(t.id));
      return allSelected ? new Set() : new Set(tickets.map((t) => t.id));
    });
  }

  /** After a bulk assign, the assigned rows drop off this list entirely — refetch rather
   *  than filter locally, and tell the nav badge to catch up in the same moment. */
  function afterBulkAction() {
    load();
    refreshUnassigned();
  }

  if (user && user.role !== 'supervisor') {
    return <Navigate to="/" replace />;
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const ticketKeys = Object.fromEntries(tickets.map((t) => [t.id, t.key]));

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Unassigned tickets</h2>
        </div>
      </header>

      <TicketFilters query={query} />

      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}

      {selected.size > 0 && (
        <BulkActionBar
          selectedIds={[...selected]}
          ticketKeys={ticketKeys}
          onClear={() => setSelected(new Set())}
          onDone={afterBulkAction}
        />
      )}

      {loading ? (
        <>
          <div className="skeleton-list" aria-hidden="true">
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
          <p className="sr-only" role="status">
            Loading unassigned tickets
          </p>
        </>
      ) : tickets.length === 0 ? (
        <div className="empty-state">
          <h3>{hasFilters ? 'Nothing here matches these filters' : 'Nothing is waiting to be assigned'}</h3>
          <p>
            {hasFilters
              ? 'Widen the search, or clear the filters to see every unassigned ticket.'
              : 'Every ticket in the queue already has someone on it.'}
          </p>
          {hasFilters && (
            <div className="page-actions">
              <button type="button" className="btn" onClick={clearFilters}>
                Clear filters
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <TicketTable
            tickets={tickets}
            sort={sort}
            dir={dir}
            onSort={toggleSort}
            selectedIds={selected}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
          />

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
