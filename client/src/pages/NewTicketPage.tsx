import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { StatusBadge } from '../components/Badges';
import type { Category, DuplicateHit, Paged, Person, Priority, Ticket } from '../types';

const PRIORITIES: Array<{ value: Priority; label: string }> = [
  { value: 'low', label: 'Low — 3 days' },
  { value: 'normal', label: 'Normal — 1 day' },
  { value: 'high', label: 'High — 4 hours' },
  { value: 'urgent', label: 'Urgent — 1 hour' },
];

const CATEGORIES: Array<{ value: Category; label: string }> = [
  { value: 'bug', label: 'Bug' },
  { value: 'billing', label: 'Billing' },
  { value: 'how_to', label: 'How-to' },
  { value: 'other', label: 'Other' },
];

export function NewTicketPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isSupervisor = user?.role === 'supervisor';

  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [requesterName, setRequesterName] = useState('');
  const [requesterEmail, setRequesterEmail] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [category, setCategory] = useState<Category>('bug');
  const [assigneeId, setAssigneeId] = useState('');
  const [assignToMe, setAssignToMe] = useState(false);

  const [agents, setAgents] = useState<Person[]>([]);
  const [duplicates, setDuplicates] = useState<DuplicateHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Only a supervisor can hand a ticket to someone, so only they need the roster.
  useEffect(() => {
    if (!isSupervisor) return;
    api
      .get<Paged<Person>>('/api/agents')
      .then((data) => setAgents(data.items))
      .catch(() => setAgents([]));
  }, [isSupervisor]);

  /**
   * Warn, don't block. The system can't tell a follow-up from a genuinely new problem,
   * but it can make sure the agent knows this customer already has something open —
   * which is the failure the whole app exists to fix.
   */
  async function checkForDuplicates() {
    if (!requesterEmail.includes('@')) return setDuplicates([]);
    try {
      const data = await api.get<Paged<DuplicateHit>>(
        `/api/tickets/duplicate-check?email=${encodeURIComponent(requesterEmail)}`
      );
      setDuplicates(data.items);
    } catch {
      // A failed check must never stop someone filing a ticket.
      setDuplicates([]);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');

    const chosenAssignee = isSupervisor ? assigneeId : assignToMe ? user?.id : undefined;

    try {
      const ticket = await api.post<Ticket>('/api/tickets', {
        subject,
        description,
        requester: { name: requesterName, email: requesterEmail },
        priority_code: priority,
        category,
        ...(chosenAssignee ? { assignee_id: chosenAssignee } : {}),
      });
      navigate(`/tickets/${ticket.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the ticket');
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <Link className="back-link" to="/tickets">
        ← Queue
      </Link>

      <header className="page-header">
        <div>
          <h2>New ticket</h2>
          <p className="page-subtitle">Log a request that arrived by email or phone.</p>
        </div>
      </header>

      {error && <div className="error-message">{error}</div>}

      <form className="ticket-form" onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="subject">Subject</label>
          <input
            id="subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Short summary of the problem"
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="description">Description</label>
          <textarea
            id="description"
            rows={6}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What the customer told you, in their words where possible"
            required
          />
        </div>

        <div className="form-row">
          <div className="form-group">
            <label htmlFor="requester-name">Requester name</label>
            <input
              id="requester-name"
              value={requesterName}
              onChange={(e) => setRequesterName(e.target.value)}
              placeholder="Jane Customer"
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="requester-email">Requester email</label>
            <input
              id="requester-email"
              type="email"
              value={requesterEmail}
              onChange={(e) => setRequesterEmail(e.target.value)}
              onBlur={checkForDuplicates}
              placeholder="jane@corp.com"
              required
            />
          </div>
        </div>

        {duplicates.length > 0 && (
          <div className="duplicate-warning" role="status">
            <strong>
              This requester already has {duplicates.length} open ticket
              {duplicates.length === 1 ? '' : 's'}.
            </strong>
            <p className="muted">Check whether this is a follow-up before filing a new one.</p>
            <ul>
              {duplicates.map((hit) => (
                <li key={hit.id}>
                  <Link to={`/tickets/${hit.id}`}>{hit.subject}</Link>
                  <StatusBadge status={hit.status} />
                  <span className="muted">
                    {hit.assignee ? `with ${hit.assignee.name}` : 'unassigned'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="form-row">
          <div className="form-group">
            <label htmlFor="priority">Priority</label>
            <select id="priority" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="category">Category</label>
            <select id="category" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {isSupervisor ? (
          <div className="form-group">
            <label htmlFor="assignee">Assign to</label>
            <select id="assignee" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Leave unassigned for triage</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          // An agent can pick a ticket up themselves or leave it for triage, but routing
          // it to a colleague is a supervisor's call — so there is no picker here.
          <label className="toggle">
            <input
              type="checkbox"
              checked={assignToMe}
              onChange={(e) => setAssignToMe(e.target.checked)}
            />
            Assign this to me
          </label>
        )}

        <div className="form-actions">
          <Link className="btn" to="/tickets">
            Cancel
          </Link>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create ticket'}
          </button>
        </div>
      </form>
    </div>
  );
}
