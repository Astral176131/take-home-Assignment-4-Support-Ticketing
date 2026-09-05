import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Paged, Person } from '../types';

interface BulkResult {
  ticket_id: string;
  success: boolean;
  reason?: string;
}

interface Props {
  selectedIds: string[];
  /**
   * Ticket id to ticket key, for the failure report. The API answers per ticket
   * id, and a bare uuid tells the person reading it nothing about which ticket
   * was refused.
   */
  ticketKeys: Record<string, string>;
  onClear: () => void;
  /** Called after any action completes, so the page can refetch and drop stale rows. */
  onDone: () => void;
}

/**
 * Supervisor-only, and only ever rendered by the caller when the viewer is one: this
 * component does not re-check the role itself, since the server is the actual authority
 * and will 403 an agent regardless of what the UI shows.
 *
 * Never treats a batch as all-or-nothing: every response is a per-ticket report, shown
 * as a summary rather than assumed to mean full success.
 */
export function BulkActionBar({ selectedIds, ticketKeys, onClear, onDone }: Props) {
  const [agents, setAgents] = useState<Person[]>([]);
  const [target, setTarget] = useState('');
  const [collaborator, setCollaborator] = useState('');
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<{ succeeded: number; failed: BulkResult[] } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get<Paged<Person>>('/api/agents')
      .then((data) => setAgents(data.items))
      .catch(() => setAgents([]));
  }, []);

  async function run(path: string, body: Record<string, unknown>, failure: string) {
    setBusy(true);
    setError('');
    setSummary(null);
    try {
      const results = await api.post<BulkResult[]>(path, body);
      const failed = results.filter((r) => !r.success);
      setSummary({ succeeded: results.length - failed.length, failed });
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${failure} ${err.message}`
          : `${failure} Check your connection, then try again. Nothing was changed.`
      );
    } finally {
      setBusy(false);
    }
  }

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? 'that agent';

  const bulkReassign = () =>
    run(
      '/api/tickets/bulk-reassign',
      { ticket_ids: selectedIds, assignee_id: target },
      `The selected tickets could not be assigned to ${agentName(target)}.`
    );

  const bulkClose = () =>
    run('/api/tickets/bulk-close', { ticket_ids: selectedIds }, 'The selected tickets could not be closed.');

  const bulkCollaborator = (action: 'add' | 'remove') =>
    run(
      '/api/tickets/bulk-collaborators',
      { ticket_ids: selectedIds, agent_id: collaborator, action },
      action === 'add'
        ? `${agentName(collaborator)} could not be added to the selected tickets.`
        : `${agentName(collaborator)} could not be removed from the selected tickets.`
    );

  return (
    <div className="bulk-bar">
      <div className="bulk-bar-row">
        <strong>
          {selectedIds.length} selected
        </strong>

        {/* Assignee. The same endpoint covers assigning an unassigned ticket and moving an
            assigned one: there is one holder either way, and "who holds this now" is the
            only thing being set. */}
        <label className="sr-only" htmlFor="bulk-reassign-to">
          Assign selected to
        </label>
        <select id="bulk-reassign-to" value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy}>
          <option value="">Assign to…</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn" disabled={busy || !target} onClick={bulkReassign}>
          {busy ? 'Working…' : 'Assign'}
        </button>
      </div>

      <div className="bulk-bar-row">
        {/* Collaborators. Add and remove are separate buttons rather than a toggle: across
            a selection the same agent is usually on some of the tickets and not others, so
            there is no single current state for a toggle to flip. */}
        <label className="sr-only" htmlFor="bulk-collaborator">
          Add or remove collaborator on selected
        </label>
        <select
          id="bulk-collaborator"
          value={collaborator}
          onChange={(e) => setCollaborator(e.target.value)}
          disabled={busy}
        >
          <option value="">Collaborator…</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn" disabled={busy || !collaborator} onClick={() => bulkCollaborator('add')}>
          Add collaborator
        </button>
        <button type="button" className="btn" disabled={busy || !collaborator} onClick={() => bulkCollaborator('remove')}>
          Remove collaborator
        </button>

        {/* "Close" alone reads as "close this bar" sitting next to Clear selection. It
            closes the tickets, and only resolved ones can be closed. */}
        <button type="button" className="btn" disabled={busy} onClick={bulkClose}>
          Close tickets
        </button>

        <button type="button" className="btn link-button" disabled={busy} onClick={onClear}>
          Clear selection
        </button>
      </div>

      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}

      {summary && (
        <div className="bulk-summary" role="status">
          <p>
            {summary.failed.length === 0
              ? `All ${summary.succeeded} succeeded.`
              : `${summary.succeeded} of ${summary.succeeded + summary.failed.length} succeeded. The rest were refused:`}
          </p>
          {summary.failed.length > 0 && (
            <ul>
              {summary.failed.map((r) => (
                <li key={r.ticket_id}>
                  {ticketKeys[r.ticket_id] ?? r.ticket_id}: {r.reason ?? 'no reason given'}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
