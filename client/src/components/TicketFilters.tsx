import type { Category, Person, Priority, TicketStatus } from '../types';
import type { ArchivedMode, TicketQuery } from '../lib/useTicketQuery';

/**
 * Filter options carry the label a person reads, not the value the API speaks. These
 * used to render the raw enum, which put "how_to" in front of the user.
 */
const STATUSES: { value: TicketStatus; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'open', label: 'Open' },
  { value: 'pending', label: 'Pending' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];

const PRIORITIES: { value: Priority; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

const CATEGORIES: { value: Category; label: string }[] = [
  { value: 'bug', label: 'Bug' },
  { value: 'billing', label: 'Billing' },
  { value: 'how_to', label: 'How-to' },
  { value: 'other', label: 'Other' },
];

const ARCHIVED: { value: ArchivedMode; label: string }[] = [
  { value: '', label: 'Hide archived' },
  { value: 'true', label: 'Include archived' },
  { value: 'only', label: 'Only archived' },
];

interface Props {
  query: TicketQuery;
  /** Supplied only where the viewer can filter by assignee, which is supervisors. */
  agents?: Person[];
}

/**
 * The filter row, shared by the queue and my-tickets so the two offer the same controls
 * and mean the same thing by them.
 */
export function TicketFilters({ query, agents }: Props) {
  const { qInput, setQInput, setParam, status, priority, category, assigneeId, archived, breaching } =
    query;

  return (
    <div className="filters-bar">
      <input
        className="filter-search"
        type="search"
        placeholder="Search subject, description or requester…"
        value={qInput}
        onChange={(e) => setQInput(e.target.value)}
        aria-label="Search tickets by subject, description or requester"
      />

      <select value={status} onChange={(e) => setParam('status', e.target.value)} aria-label="Filter by status">
        <option value="">All statuses</option>
        {STATUSES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <select value={priority} onChange={(e) => setParam('priority', e.target.value)} aria-label="Filter by priority">
        <option value="">All priorities</option>
        {PRIORITIES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <select value={category} onChange={(e) => setParam('category', e.target.value)} aria-label="Filter by category">
        <option value="">All categories</option>
        {CATEGORIES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      {agents && (
        <select
          value={assigneeId}
          onChange={(e) => setParam('assignee_id', e.target.value)}
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

      {/* Three states, so a select rather than a checkbox: the archive is somewhere you
          can go, not just something you can include. */}
      <select
        value={archived}
        onChange={(e) => setParam('archived', e.target.value)}
        aria-label="Archived tickets"
      >
        {ARCHIVED.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <label className="toggle">
        <input
          type="checkbox"
          checked={breaching}
          onChange={(e) => setParam('breaching', e.target.checked ? 'true' : '')}
        />
        Past response target
      </label>
    </div>
  );
}
