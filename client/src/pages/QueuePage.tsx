import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { TicketTable } from '../components/TicketTable';
import { TicketFilters } from '../components/TicketFilters';
import { Pagination } from '../components/Pagination';
import { BulkActionBar } from '../components/BulkActionBar';
import { useAuth } from '../context/AuthContext';
import { usePageMeta } from '../lib/usePageMeta';
import { PAGE_SIZE, useTicketQuery } from '../lib/useTicketQuery';
import type { Paged, Person, TicketListItem } from '../types';

export function QueuePage() {
  const { user } = useAuth();
  const isSupervisor = user?.role === 'supervisor';

  usePageMeta(
    'Queue',
    'Search and filter the whole support queue by status, priority, category and assignee, sort it by priority or last update, and act on several tickets at once.'
  );

  const query = useTicketQuery();
  const { queryString, page, sort, dir, setParam, toggleSort, hasFilters, clearFilters } = query;

  const [tickets, setTickets] = useState<TicketListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const [agents, setAgents] = useState<Person[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Only a supervisor can filter or bulk-act by assignee, since only they can reach the
  // agent roster at all (GET /api/agents is supervisor-only).
  useEffect(() => {
    if (!isSupervisor) return;
    api
      .get<Paged<Person>>('/api/agents')
      .then((data) => setAgents(data.items))
      .catch(() => setAgents([]));
  }, [isSupervisor]);

  // Whatever was selected almost certainly no longer refers to what is on screen once the
  // result set changes. (Paging back to a page resets it too, which is the safe direction
  // to be wrong in: acting on rows you can no longer see is the thing worth preventing.)
  useEffect(() => {
    setSelected(new Set());
  }, [queryString]);

  useEffect(() => {
    setLoading(true);
    api
      .get<Paged<TicketListItem>>(`/api/tickets?${queryString}`)
      .then((data) => {
        setTickets(data.items);
        setTotal(data.total);
        setError('');
      })
      .catch((err) =>
        setError(
          err instanceof ApiError
            ? `The queue could not be loaded. ${err.message}`
            : 'The queue could not be loaded. Check your connection, then reload the page.'
        )
      )
      .finally(() => setLoading(false));
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

  /** Reload the current page after a bulk action, without resetting filters or selection. */
  function refetch() {
    setLoading(true);
    api
      .get<Paged<TicketListItem>>(`/api/tickets?${queryString}`)
      .then((data) => {
        setTickets(data.items);
        setTotal(data.total);
      })
      .finally(() => setLoading(false));
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // The bulk report comes back keyed by ticket id; this is how it gets turned back into
  // something a person can read.
  const ticketKeys = Object.fromEntries(tickets.map((t) => [t.id, t.key]));

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Queue</h2>
        </div>
        <div className="page-actions">
          <a className="btn" href={`/api/tickets/export.csv?${queryString}`}>
            Export CSV
          </a>
          <Link className="btn btn-primary" to="/tickets/new">
            New ticket
          </Link>
        </div>
      </header>

      <TicketFilters query={query} agents={isSupervisor ? agents : undefined} />

      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}

      {isSupervisor && selected.size > 0 && (
        <BulkActionBar
          selectedIds={[...selected]}
          ticketKeys={ticketKeys}
          onClear={() => setSelected(new Set())}
          onDone={refetch}
        />
      )}

      {loading ? (
        <>
          <div className="skeleton-list" aria-hidden="true">
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
          <p className="sr-only" role="status">
            Loading tickets
          </p>
        </>
      ) : tickets.length === 0 ? (
        <div className="empty-state">
          <h3>No tickets match these filters</h3>
          <p>
            {hasFilters
              ? 'Widen the search, or clear the filters to see the whole queue.'
              : 'Nothing is in the queue yet. Log the first request that came in by email or phone.'}
          </p>
          <div className="page-actions">
            {hasFilters && (
              <button type="button" className="btn" onClick={clearFilters}>
                Clear filters
              </button>
            )}
            <Link className="btn btn-primary" to="/tickets/new">
              New ticket
            </Link>
          </div>
        </div>
      ) : (
        <>
          <TicketTable
            tickets={tickets}
            sort={sort}
            dir={dir}
            onSort={toggleSort}
            selectedIds={isSupervisor ? selected : undefined}
            onToggleSelect={isSupervisor ? toggleSelect : undefined}
            onToggleSelectAll={isSupervisor ? toggleSelectAll : undefined}
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
