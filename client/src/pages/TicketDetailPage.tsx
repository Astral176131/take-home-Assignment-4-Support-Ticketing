import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { categoryLabel, timeAgo } from '../lib/format';
import { PriorityBadge, SlaBadge, StatusBadge } from '../components/Badges';
import { ActivityFeed } from '../components/ActivityFeed';
import { ReplyForm } from '../components/ReplyForm';
import { StatusActions } from '../components/StatusActions';
import { TicketPeople } from '../components/TicketPeople';
import type { Ticket, TicketStatus } from '../types';

export function TicketDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setTicket(await api.get<Ticket>(`/api/tickets/${id}`));
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this ticket');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Every action returns the updated ticket, so the page re-renders from the server's
   * view rather than guessing what changed — which is what keeps the action buttons
   * honest after a status move.
   */
  async function act(run: () => Promise<Ticket>) {
    setBusy(true);
    setError('');
    try {
      setTicket(await run());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  const changeStatus = (status: TicketStatus) =>
    act(() => api.post<Ticket>(`/api/tickets/${id}/status`, { status }));

  const addReply = (reply: { body: string; is_internal: boolean; author_type: 'agent' | 'customer' }) =>
    act(() => api.post<Ticket>(`/api/tickets/${id}/replies`, reply));

  const toggleArchive = () =>
    act(() => api.post<Ticket>(`/api/tickets/${id}/${ticket?.archived_at ? 'restore' : 'archive'}`));

  const reassign = (assigneeId: string) =>
    act(() => api.post<Ticket>(`/api/tickets/${id}/reassign`, { assignee_id: assigneeId }));

  const addCollaborator = (agentId: string) =>
    act(() => api.post<Ticket>(`/api/tickets/${id}/collaborators`, { agent_id: agentId }));

  const removeCollaborator = (agentId: string) =>
    act(() => api.del<Ticket>(`/api/tickets/${id}/collaborators/${agentId}`));

  if (loading) return <p className="muted">Loading…</p>;

  if (!ticket) {
    return (
      <div className="page">
        <div className="error-message">{error || 'Ticket not found'}</div>
        <p>
          <Link to="/tickets">Back to the queue</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="page">
      <Link className="back-link" to="/tickets">
        ← Queue
      </Link>

      {error && <div className="error-message">{error}</div>}

      <div className="ticket-layout">
        <main className="ticket-main">
          <div className="ticket-heading">
            <h2>{ticket.subject}</h2>
            <StatusBadge status={ticket.status} />
            {ticket.archived_at && <span className="chip chip-archived">Archived</span>}
          </div>

          <p className="ticket-description">{ticket.description}</p>

          <ActivityFeed ticket={ticket} />

          {ticket.archived_at ? (
            <p className="muted">Restore this ticket to reply to it.</p>
          ) : (
            <ReplyForm busy={busy} onSubmit={addReply} />
          )}
        </main>

        <aside className="ticket-sidebar">
          <dl className="ticket-fields">
            <dt>Status</dt>
            <dd>
              <StatusBadge status={ticket.status} />
            </dd>

            <dt>Assignee</dt>
            <dd>{ticket.assignee?.name ?? <span className="muted">Unassigned</span>}</dd>

            <dt>Requester</dt>
            <dd>
              {ticket.requester.name}
              <div className="muted">{ticket.requester.email}</div>
            </dd>

            <dt>Priority</dt>
            <dd>
              <PriorityBadge priority={ticket.priority_code} />
            </dd>

            <dt>Category</dt>
            <dd>{categoryLabel(ticket.category)}</dd>

            <dt>Response</dt>
            <dd>
              <SlaBadge sla={ticket.sla} />
            </dd>

            <dt>Collaborators</dt>
            <dd>
              {ticket.collaborators.length === 0 ? (
                <span className="muted">None</span>
              ) : (
                ticket.collaborators.map((c) => c.name).join(', ')
              )}
            </dd>

            <dt>Created</dt>
            <dd className="muted">{timeAgo(ticket.created_at)}</dd>
          </dl>

          {!ticket.archived_at && (
            <TicketPeople
              ticket={ticket}
              busy={busy}
              onReassign={reassign}
              onAddCollaborator={addCollaborator}
              onRemoveCollaborator={removeCollaborator}
            />
          )}

          <div className="sidebar-section">
            <h3>Actions</h3>
            {ticket.archived_at ? (
              <p className="muted">Archived tickets are frozen.</p>
            ) : (
              <StatusActions ticket={ticket} busy={busy} onChange={changeStatus} />
            )}
            <button className="btn archive-btn" disabled={busy} onClick={toggleArchive}>
              {ticket.archived_at ? 'Restore' : 'Archive'}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
