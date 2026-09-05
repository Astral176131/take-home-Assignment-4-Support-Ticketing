import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { PriorityBadge, SlaGauge, StatusBadge } from '../components/Badges';
import { useAlerts } from '../context/AlertsContext';
import { usePageMeta } from '../lib/usePageMeta';

/**
 * Sorted most-severe-first by the server already, so this page renders that order as given
 * rather than re-sorting, so there is one definition of "most severe" for the whole app.
 *
 * The alerts themselves come from the shared context rather than a fetch of this page's
 * own, so acknowledging one here updates the nav badge at the same moment it disappears
 * from this table. The two used to be separate copies of the same list, and only this one
 * knew it had changed.
 */
export function AlertsPage() {
  const { items: alerts, acknowledged, loading, error, refresh } = useAlerts();
  const [ackError, setAckError] = useState('');
  const [ackNotice, setAckNotice] = useState('');
  const [ackingId, setAckingId] = useState<string | null>(null);

  usePageMeta(
    'Alerts',
    'Every ticket that is past its response target or close to breaching it, listed most severe first, each with a single action to acknowledge and silence it.'
  );

  async function acknowledge(ticketId: string, key: string) {
    setAckingId(ticketId);
    setAckError('');
    setAckNotice('');
    try {
      await api.post(`/api/tickets/${ticketId}/alerts/ack`);
      // Refetch rather than filter locally: acknowledging can change more than just this
      // ticket's own visibility (e.g. a supervisor's list is a superset of an agent's).
      await refresh();
      // The row disappearing is the only other signal that anything happened,
      // and a row vanishing reads as easily like a bug as like success.
      setAckNotice(`${key} acknowledged. It stays silent until the ticket is reopened.`);
    } catch (err) {
      setAckError(
        err instanceof ApiError
          ? `${key} could not be acknowledged. ${err.message}`
          : `${key} could not be acknowledged. Check your connection, then try again.`
      );
    } finally {
      setAckingId(null);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Alerts</h2>
        </div>
      </header>

      {/* Two different failures: the list could not be loaded, or one acknowledgement was
          refused. Keeping them apart means a refused ack does not read as a broken page. */}
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      {ackError && (
        <div className="error-message" role="alert">
          {ackError}
        </div>
      )}
      {ackNotice && (
        <div className="success-message" role="status">
          {ackNotice}
        </div>
      )}

      {loading ? (
        <>
          <div className="skeleton-list" aria-hidden="true">
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
          <p className="sr-only" role="status">
            Loading alerts
          </p>
        </>
      ) : alerts.length === 0 ? (
        <div className="empty-state">
          {/* Two different empty states. "Everything is within target" is only true
              when nothing has been silenced; said unconditionally it contradicts the
              dashboard's breaching count, which ignores acknowledgement. The reason
              the two numbers differ is explained on the dashboard tile itself, so it
              is not repeated here. */}
          {acknowledged > 0 ? (
            <>
              <h3>Nothing needs attention right now</h3>
              <p>
                {acknowledged === 1
                  ? '1 acknowledged ticket is still past its target. It stays quiet unless the ticket is reopened.'
                  : `${acknowledged} acknowledged tickets are still past their targets. They stay quiet unless those tickets are reopened.`}
              </p>
            </>
          ) : (
            <>
              <h3>No active alerts</h3>
              <p>Everything is within its response target.</p>
            </>
          )}
        </div>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Alerts">
          <table className="queue-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Subject</th>
                <th>Status</th>
                <th>Priority</th>
                <th>Assignee</th>
                <th>Response</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((alert) => (
                <tr key={alert.id}>
                  <td className="ticket-key tabular">{alert.key}</td>
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
                    <SlaGauge sla={alert.sla} />
                  </td>
                  <td>
                    <button
                      className="btn ack-btn"
                      disabled={ackingId === alert.id}
                      onClick={() => acknowledge(alert.id, alert.key)}
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
