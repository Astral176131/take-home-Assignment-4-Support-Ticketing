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
  onClear: () => void;
  /** Called after any action completes, so the page can refetch and drop stale rows. */
  onDone: () => void;
}

/**
 * Supervisor-only, and only ever rendered by the caller when the viewer is one — this
 * component does not re-check the role itself, since the server is the actual authority
 * and will 403 an agent regardless of what the UI shows.
 *
 * Never treats a batch as all-or-nothing: every response is a per-ticket report, shown
 * as a summary rather than assumed to mean full success.
 */
export function BulkActionBar({ selectedIds, onClear, onDone }: Props) {
  const [agents, setAgents] = useState<Person[]>([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<{ succeeded: number; failed: BulkResult[] } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get<Paged<Person>>('/api/agents')
      .then((data) => setAgents(data.items))
      .catch(() => setAgents([]));
  }, []);

  async function run(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setError('');
    setSummary(null);
    try {
      const results = await api.post<BulkResult[]>(path, body);
      const failed = results.filter((r) => !r.success);
      setSummary({ succeeded: results.length - failed.length, failed });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  const bulkReassign = () => run('/api/tickets/bulk-reassign', { ticket_ids: selectedIds, assignee_id: target });
  const bulkClose = () => run('/api/tickets/bulk-close', { ticket_ids: selectedIds });

  return (
    <div className="bulk-bar">
      <div className="bulk-bar-row">
        <span>{selectedIds.length} selected</span>

        <label className="sr-only" htmlFor="bulk-reassign-to">
          Reassign selected to
        </label>
        <select id="bulk-reassign-to" value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy}>
          <option value="">Reassign to…</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
        <button className="btn" disabled={busy || !target} onClick={bulkReassign}>
          Reassign
        </button>

        <button className="btn" disabled={busy} onClick={bulkClose}>
          Close
        </button>

        <button className="btn link-button" disabled={busy} onClick={onClear}>
          Clear selection
        </button>
      </div>

      {error && <div className="error-message">{error}</div>}

      {summary && (
        <div className="bulk-summary" role="status">
          <p>
            {summary.succeeded} of {summary.succeeded + summary.failed.length} succeeded.
          </p>
          {summary.failed.length > 0 && (
            <ul>
              {summary.failed.map((r) => (
                <li key={r.ticket_id}>
                  {r.ticket_id}: {r.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
