import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { categoryLabel, duration, timeAgo } from '../lib/format';
import { PriorityBadge, SlaGauge, StatusBadge } from '../components/Badges';
import { ActivityFeed } from '../components/ActivityFeed';
import { ReplyForm } from '../components/ReplyForm';
import { StatusActions, pastLabel } from '../components/StatusActions';
import { TicketEditForm, type TicketEdits } from '../components/TicketEditForm';
import { TicketPeople } from '../components/TicketPeople';
import { useAlerts } from '../context/AlertsContext';
import { usePageMeta } from '../lib/usePageMeta';
import type { Ticket, TicketStatus } from '../types';

export function TicketDetailPage() {
  const { id } = useParams<{ id: string }>();
  // A ticket just created lands here; the confirmation travels with the
  // navigation rather than flashing on a page the user is leaving.
  const location = useLocation();
  const arrivalNotice = (location.state as { notice?: string } | null)?.notice ?? '';
  const { refresh: refreshAlerts } = useAlerts();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(arrivalNotice);

  usePageMeta(
    ticket ? `${ticket.key} ${ticket.subject}` : 'Ticket',
    ticket
      ? `${ticket.key}: ${ticket.subject}. Raised by ${ticket.requester.name}, currently ${ticket.status}, ${ticket.assignee ? `assigned to ${ticket.assignee.name}` : 'unassigned'}. Read the thread, reply, and move it through the lifecycle.`
      : 'Read a support ticket, reply to the customer or leave an internal note, and move it through its lifecycle.'
  );

  const load = useCallback(async () => {
    try {
      setTicket(await api.get<Ticket>(`/api/tickets/${id}`));
      setError('');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `This ticket could not be opened. ${err.message}`
          : 'This ticket could not be opened. Check your connection, then reload the page.'
      );
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Every action returns the updated ticket, so the page re-renders from the server's
   * view rather than guessing what changed, which is what keeps the action buttons
   * honest after a status move.
   *
   * Returns whether the call actually succeeded, rather than swallowing the failure
   * silently: ReplyForm relies on this to decide whether to clear what was typed. Without
   * it, `act` always resolves normally (it catches internally to show `error`), so a
   * caller awaiting it can't otherwise tell success from failure.
   *
   * Each caller supplies what to say on the way out. Every one of these used to
   * report "That did not work" on failure and nothing at all on success, which
   * left the page silently mutating under the user.
   */
  async function act(
    run: () => Promise<Ticket>,
    success: string,
    failure: string
  ): Promise<boolean> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      setTicket(await run());
      // Almost everything here can change whether this ticket is alerting: acknowledging
      // silences it, resolving ends its clock, a customer reply restarts one, so the
      // shared count is refreshed rather than left to catch up on its next poll.
      refreshAlerts();
      setNotice(success);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? `${failure} ${err.message}` : `${failure} Check your connection, then try again.`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const changeStatus = (status: TicketStatus) =>
    act(
      () => api.post<Ticket>(`/api/tickets/${id}/status`, { status }),
      pastLabel(ticket?.status ?? 'new', status),
      'The status could not be changed.'
    );

  const addReply = (reply: { body: string; is_internal: boolean; author_type: 'agent' | 'customer' }) =>
    act(
      () => api.post<Ticket>(`/api/tickets/${id}/replies`, reply),
      reply.is_internal
        ? 'Internal note added. The customer cannot see it.'
        : reply.author_type === 'customer'
          ? 'Customer email logged.'
          : 'Reply added.',
      'The reply could not be added. Your text is still in the box.'
    );

  const toggleArchive = () =>
    act(
      () => api.post<Ticket>(`/api/tickets/${id}/${ticket?.archived_at ? 'restore' : 'archive'}`),
      ticket?.archived_at ? 'Restored. This ticket is back in the queue.' : 'Archived. Its history is kept.',
      ticket?.archived_at ? 'This ticket could not be restored.' : 'This ticket could not be archived.'
    );

  const reassign = (assigneeId: string) =>
    act(
      () => api.post<Ticket>(`/api/tickets/${id}/reassign`, { assignee_id: assigneeId }),
      'Reassigned.',
      'This ticket could not be reassigned.'
    );

  const addCollaborator = (agentId: string) =>
    act(
      () => api.post<Ticket>(`/api/tickets/${id}/collaborators`, { agent_id: agentId }),
      'Collaborator added.',
      'That collaborator could not be added.'
    );

  const removeCollaborator = (agentId: string) =>
    act(
      () => api.del<Ticket>(`/api/tickets/${id}/collaborators/${agentId}`),
      'Collaborator removed.',
      'That collaborator could not be removed.'
    );

  const acknowledge = () =>
    act(
      () => api.post<Ticket>(`/api/tickets/${id}/alerts/ack`),
      'Alert acknowledged. It stays silent until this ticket is reopened.',
      'The alert could not be acknowledged.'
    );

  const saveEdits = (edits: TicketEdits) =>
    act(
      () => api.patch<Ticket>(`/api/tickets/${id}`, edits),
      'Changes saved.',
      'Your changes could not be saved. They are still in the form.'
    );

  if (loading) {
    return (
      <div className="page">
        <div className="skeleton-list" aria-hidden="true">
          <div className="skeleton" />
          <div className="skeleton skeleton-tall" />
          <div className="skeleton skeleton-tall" />
        </div>
        <p className="sr-only" role="status">
          Loading this ticket
        </p>
      </div>
    );
  }

  if (!ticket) {
    return (
      <div className="page">
        <div className="notfound">
          <p className="notfound-code">Not found</p>
          <h1>This ticket is not available</h1>
          <p>{error || 'It may have been removed, or you may not have access to it.'}</p>
          <div className="notfound-actions">
            <Link className="btn btn-primary" to="/tickets">
              Back to the queue
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <Link className="back-link" to="/tickets">
        Back to the queue
      </Link>

      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="success-message" role="status">
          {notice}
        </div>
      )}

      <div className="ticket-layout">
        {/* A div, not a main: the app shell already provides the page's one main
            landmark, and nesting a second inside it is invalid. */}
        <div className="ticket-body">
          <div className="ticket-heading">
            <span className="ticket-key tabular">{ticket.key}</span>
            <StatusBadge status={ticket.status} />
            {ticket.archived_at && <span className="chip chip-archived">Archived</span>}
            {/* No role check: editing a ticket's fields needs exactly the access that
                loading this page already required, so anyone reading it may edit it. */}
            {!ticket.archived_at && !editing && (
              <button type="button" className="btn edit-btn" disabled={busy} onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
            <h2>{ticket.subject}</h2>
          </div>

          {editing ? (
            <TicketEditForm
              ticket={ticket}
              busy={busy}
              onSave={saveEdits}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <p className="ticket-description">{ticket.description}</p>
          )}

          <ActivityFeed ticket={ticket} />

          {ticket.archived_at ? (
            <p className="muted">Restore this ticket to reply to it.</p>
          ) : (
            <ReplyForm busy={busy} onSubmit={addReply} />
          )}
        </div>

        <aside className="ticket-sidebar" aria-label="Ticket details">
          {/* The response standing leads the sidebar, and on a narrow screen the
              whole sidebar leads the page. It is the thing this ticket was most
              likely opened to check. */}
          <div className="response-panel">
            <h3>Response target</h3>
            <SlaGauge sla={ticket.sla} lead />
            {ticket.sla.alert_active && (
              <button type="button" className="btn ack-btn" disabled={busy} onClick={acknowledge}>
                Acknowledge
              </button>
            )}
            {/* Acknowledging is a snooze, not a dismissal, so say when it comes back.
                Otherwise the button looks like it made the problem go away. */}
            {ticket.sla.snoozed_for_minutes !== null && (
              <p className="muted snooze-note">
                Acknowledged. Alerts again in {duration(ticket.sla.snoozed_for_minutes)} if this
                is still open.
              </p>
            )}
          </div>

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
            <button type="button" className="btn archive-btn" disabled={busy} onClick={toggleArchive}>
              {ticket.archived_at ? 'Restore' : 'Archive'}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
