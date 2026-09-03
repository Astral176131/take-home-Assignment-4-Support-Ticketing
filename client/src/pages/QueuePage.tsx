import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { TicketTable } from '../components/TicketTable';
import { BulkActionBar } from '../components/BulkActionBar';
import { useAuth } from '../context/AuthContext';
import type { Category, Paged, Person, Priority, SortDirection, TicketListItem, TicketSortField, TicketStatus } from '../types';

const PAGE_SIZE = 25;

const STATUSES: TicketStatus[] = ['new', 'open', 'pending', 'resolved', 'closed'];
const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent'];
const CATEGORIES: Category[] = ['bug', 'billing', 'how_to', 'other'];

export function QueuePage() {
  const { user } = useAuth();
  const isSupervisor = user?.role === 'supervisor';

  const [tickets, setTickets] = useState<TicketListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // The text box updates immediately; `q` — what actually drives the fetch — only catches
  // up after a short pause, so typing doesn't fire a request per keystroke.
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setQ(qInput), 300);
    return () => clearTimeout(id);
  }, [qInput]);

  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [category, setCategory] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [sort, setSort] = useState<TicketSortField>('created_at');
  const [dir, setDir] = useState<SortDirection>('desc');
  const [page, setPage] = useState(1);

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

  // Any change here means a different page 1 result set, so page resets — and whatever
  // was selected almost certainly no longer refers to what's on screen.
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [q, status, priority, category, assigneeId, showArchived, sort, dir]);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    if (priority) params.set('priority', priority);
    if (category) params.set('category', category);
    if (assigneeId) params.set('assignee_id', assigneeId);
    if (showArchived) params.set('archived', 'true');
    params.set('sort', sort);
    params.set('dir', dir);
    params.set('page', String(page));
    params.set('page_size', String(PAGE_SIZE));
    return params.toString();
  }, [q, status, priority, category, assigneeId, showArchived, sort, dir, page]);

  useEffect(() => {
    setLoading(true);
    api
      .get<Paged<TicketListItem>>(`/api/tickets?${queryString}`)
      .then((data) => {
        setTickets(data.items);
        setTotal(data.total);
        setError('');
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load tickets'))
      .finally(() => setLoading(false));
  }, [queryString]);

  function toggleSort(field: TicketSortField) {
    if (sort === field) {
      setDir(dir === 'asc' ? 'desc' : 'asc');
    } else {
      // A newly clicked column always starts descending — newest/highest first, matching
      // the default the page loads with.
      setSort(field);
      setDir('desc');
    }
  }

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

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Queue</h2>
          <p className="page-subtitle">
            {/* Scoping is enforced server-side; this only explains what you are seeing. */}
            {isSupervisor
              ? 'Every ticket in the system'
              : 'Tickets assigned to you or where you are a collaborator'}
          </p>
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

      <div className="filters-bar">
        <input
          className="filter-search"
          type="search"
          placeholder="Search subject and description…"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          aria-label="Search tickets"
        />

        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Filter by priority">
          <option value="">All priorities</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category">
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        {isSupervisor && (
          <select
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            aria-label="Filter by assignee"
          >
            <option value="">All assignees</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        )}

        <label className="toggle">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
      </div>

      {error && <div className="error-message">{error}</div>}

      {isSupervisor && selected.size > 0 && (
        <BulkActionBar
          selectedIds={[...selected]}
          onClear={() => setSelected(new Set())}
          onDone={refetch}
        />
      )}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : tickets.length === 0 ? (
        <div className="empty-state">
          <p>No tickets match these filters.</p>
          <Link className="btn btn-primary" to="/tickets/new">
            Create a ticket
          </Link>
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

          <div className="pagination">
            <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <span className="muted">
              Page {page} of {totalPages} · {total} ticket{total === 1 ? '' : 's'}
            </span>
            <button className="btn" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
