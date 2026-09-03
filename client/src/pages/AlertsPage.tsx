import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { PriorityBadge, SlaBadge, StatusBadge } from '../components/Badges';
import { useAuth } from '../context/AuthContext';
import type { Paged, TicketListItem } from '../types';

/**
 * Sorted most-severe-first by the server already — this page renders that order as given
 * rather than re-sorting, so there is one definition of "most severe" for the whole app.
 */
export function AlertsPage() {
  const { user } = useAuth();
  const [alerts, setAlerts] = useState<TicketListItem[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [ackingId, setAckingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<Paged<TicketListItem>>('/api/alerts');
      setAlerts(data.items);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load alerts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function acknowledge(ticketId: string) {
    setAckingId(ticketId);
    setError('');
    try {
      await api.post(`/api/tickets/${ticketId}/alerts/ack`);
      // Reload rather than filter locally — acknowledging can change more than just this
      // ticket's own visibility (e.g. a supervisor's list is a superset of an agent's).
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not acknowledge this alert');
    } finally {
      setAckingId(null);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Alerts</h2>
          <p className="page-subtitle">
            {user?.role === 'supervisor'
              ? 'Every ticket currently breaching or close to breaching its response target'
              : 'Your tickets currently breaching or close to breaching their response target'}
          </p>
        </div>
      </header>

      {error && <div className="error-message">{error}</div>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : alerts.length === 0 ? (
        <div className="empty-state">
          <p>No active alerts. Everything is within its response target.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="queue-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Subject</th>
                <th>Status</th>
                <th>Priority</th>
                <th>Assignee</th>
                <th>Response</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {alerts.map((alert) => (
                <tr key={alert.id}>
                  <td className="muted ticket-key">{alert.key}</td>
                  <td>
                    <Link className="ticket-link" to={`/tickets/${alert.id}`}>
                      {alert.subject}
                    </Link>
                  </td>
                  <td>
                    <StatusBadge status={alert.status} />
                  </td>
                  <td>
                    <PriorityBadge priority={alert.priority_code} />
                  </td>
                  <td>{alert.assignee?.name ?? <span className="muted">Unassigned</span>}</td>
                  <td>
                    <SlaBadge sla={alert.sla} />
                  </td>
                  <td>
                    <button
                      className="btn ack-btn"
                      disabled={ackingId === alert.id}
                      onClick={() => acknowledge(alert.id)}
                    >
                      {ackingId === alert.id ? 'Acknowledging…' : 'Acknowledge'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
