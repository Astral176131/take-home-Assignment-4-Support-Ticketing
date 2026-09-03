import { Link } from 'react-router-dom';
import { PriorityBadge, SlaBadge, StatusBadge } from './Badges';
import { categoryLabel, timeAgo } from '../lib/format';
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
    <th>
      <button className={`sort-header${active ? ' active' : ''}`} onClick={() => onSort(field)}>
        {label}
        {active && <span aria-hidden="true">{dir === 'asc' ? ' ▲' : ' ▼'}</span>}
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
  /** Checkboxes appear only when supplied — bulk actions are supervisor-only. */
  selectedIds?: Set<string>;
  onToggleSelect?: (ticketId: string) => void;
  onToggleSelectAll?: () => void;
}

/**
 * The queue table, shared by the full queue and the my-tickets view. Both render the same
 * columns from the same payload shape, so there is one definition of what a ticket row
 * looks like rather than two that drift. Sorting and selection are opt-in via props so
 * my-tickets — which offers neither — renders the identical table unchanged.
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

  return (
    <div className="table-wrap">
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
              <td className="muted ticket-key">{ticket.key}</td>
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
