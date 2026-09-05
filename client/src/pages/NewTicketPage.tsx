import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { StatusBadge } from '../components/Badges';
import { CATEGORY_OPTIONS, PRIORITY_OPTIONS } from '../lib/options';
import { usePageMeta } from '../lib/usePageMeta';
import type { Category, DuplicateHit, Paged, Person, Priority, Ticket } from '../types';

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

  usePageMeta(
    'New ticket',
    'Log a support request that arrived by email or by phone: the subject, what the customer said, who raised it, its priority and category, and who picks it up.'
  );
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
   * but it can make sure the agent knows this customer already has something open,
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
      navigate(`/tickets/${ticket.id}`, {
        state: { notice: ticket.key ? `${ticket.key} created.` : 'Ticket created.' },
      });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `The ticket could not be created. ${err.message}`
          : 'The ticket could not be created. Check your connection, then try again. Nothing you typed has been lost.'
      );
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <Link className="back-link" to="/tickets">
        Back to the queue
      </Link>

      <header className="page-header">
        <div>
          <h2>New ticket</h2>
        </div>
      </header>

      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}

      <form className="ticket-form" onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="subject">Subject</label>
          <input
            id="subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Card declined at checkout"
            autoComplete="off"
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
            placeholder="What the customer told you, in their words where possible…"
            autoComplete="off"
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
              placeholder="Dana Osei"
              autoComplete="off"
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
              placeholder="dana@northgate.co"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
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
              {PRIORITY_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="category">Category</label>
            <select id="category" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
              {CATEGORY_OPTIONS.map((c) => (
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
          // it to a colleague is a supervisor's call, so there is no picker here.
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
