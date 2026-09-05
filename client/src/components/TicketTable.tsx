import { Link } from 'react-router-dom';
import { PriorityBadge, SlaGauge, StatusBadge } from './Badges';
import { categoryLabel, timeAgo } from '../lib/format';
import { useMediaQuery } from '../lib/useMediaQuery';
import type { SortDirection, TicketListItem, TicketSortField } from '../types';

interface SortableHeaderProps {
  field: TicketSortField;
  label: string;
  sort: TicketSortField;
  dir: SortDirection;
  onSort: (field: TicketSortField) => void;
}

function SortableHeader({ field, label, sort, dir, onSort }: SortableHeaderProps) {
  const active = sort === field;
  return (
    // aria-sort belongs on the cell, not the button: it tells a screen reader
    // how the column is currently ordered, which the arrow glyph alone does not.
    <th aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        className={`sort-header${active ? ' active' : ''}`}
        onClick={() => onSort(field)}
      >
        {label}
        {active && <span aria-hidden="true">{dir === 'asc' ? '▲' : '▼'}</span>}
        <span className="sr-only">
          {active
            ? `, sorted ${dir === 'asc' ? 'ascending' : 'descending'}. Activate to reverse.`
            : ', not sorted. Activate to sort by this column.'}
        </span>
      </button>
    </th>
  );
}

interface Props {
  tickets: TicketListItem[];
  /** Sortable Priority/Updated headers appear only when both are supplied. */
  sort?: TicketSortField;
  dir?: SortDirection;
  onSort?: (field: TicketSortField) => void;
  /** Checkboxes appear only when supplied - bulk actions are supervisor-only. */
  selectedIds?: Set<string>;
  onToggleSelect?: (ticketId: string) => void;
  onToggleSelectAll?: () => void;
}

/**
 * The queue table, shared by the full queue and the my-tickets view. Both render the same
 * columns from the same payload shape, so there is one definition of what a ticket row
 * looks like rather than two that drift. Sorting and selection are opt-in via props so
 * my-tickets, which offers neither, renders the identical table unchanged.
 *
 * Under 640px the same rows are rendered as stacked cards instead. A ten-column
 * table inside a 288px viewport is unreadable whether or not its scroll is
 * contained, and horizontal scrolling to read a queue is not a queue.
 */
export function TicketTable({
  tickets,
  sort,
  dir,
  onSort,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
}: Props) {
  const selectable = !!(selectedIds && onToggleSelect && onToggleSelectAll);
  const sortable = !!(sort && dir && onSort);
  const allSelected = selectable && tickets.length > 0 && tickets.every((t) => selectedIds!.has(t.id));
  const narrow = useMediaQuery('(max-width: 639px)');

  if (narrow) {
    return (
      <ul className="ticket-cards">
        {tickets.map((ticket) => (
          <li key={ticket.id} className="ticket-card">
            <div className="ticket-card-top">
              <div>
                <span className="ticket-key tabular">{ticket.key}</span>
                <div>
                  <Link className="ticket-link" to={`/tickets/${ticket.id}`}>
                    {ticket.subject}
                  </Link>
                </div>
              </div>
              {selectable && (
                <label className="ticket-card-select">
                  <input
                    type="checkbox"
                    aria-label={`Select ${ticket.key}`}
                    checked={selectedIds!.has(ticket.id)}
                    onChange={() => onToggleSelect!(ticket.id)}
                  />
                </label>
              )}
            </div>

            <div className="ticket-card-meta">
              <StatusBadge status={ticket.status} />
              <PriorityBadge priority={ticket.priority_code} />
              <span>{categoryLabel(ticket.category)}</span>
              <span>{ticket.assignee?.name ?? 'Unassigned'}</span>
              {ticket.archived_at && <span className="chip chip-archived">Archived</span>}
            </div>

            <SlaGauge sla={ticket.sla} />

            <span className="muted">Updated {timeAgo(ticket.updated_at)}</span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    // tabindex makes the scroll container reachable from the keyboard; without
    // it a column that only exists past the right edge cannot be reached at all.
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Tickets">
      <table className="queue-table">
        <thead>
          <tr>
            {selectable && (
              <th className="select-col">
                <input
                  type="checkbox"
                  aria-label="Select all tickets on this page"
                  checked={allSelected}
                  onChange={onToggleSelectAll}
                />
              </th>
            )}
            <th>Key</th>
            <th>Subject</th>
            <th>Status</th>
            {sortable ? (
              <SortableHeader field="priority" label="Priority" sort={sort!} dir={dir!} onSort={onSort!} />
            ) : (
              <th>Priority</th>
            )}
            <th>Category</th>
            <th>Requester</th>
            <th>Assignee</th>
            <th>Response</th>
            {sortable ? (
              <SortableHeader field="updated_at" label="Updated" sort={sort!} dir={dir!} onSort={onSort!} />
            ) : (
              <th>Updated</th>
            )}
          </tr>
        </thead>
        <tbody>
          {tickets.map((ticket) => (
            <tr key={ticket.id} className={ticket.archived_at ? 'row-archived' : undefined}>
              {selectable && (
                <td className="select-col">
                  <input
                    type="checkbox"
                    aria-label={`Select ${ticket.key}`}
                    checked={selectedIds!.has(ticket.id)}
                    onChange={() => onToggleSelect!(ticket.id)}
                  />
                </td>
              )}
              <td className="ticket-key tabular">{ticket.key}</td>
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
                <SlaGauge sla={ticket.sla} />
              </td>
              <td className="muted tabular">{timeAgo(ticket.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
