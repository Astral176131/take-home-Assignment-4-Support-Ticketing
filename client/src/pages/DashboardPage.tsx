import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { StatTile } from '../components/StatTile';
import { HorizontalBars, WeeklyBarChart } from '../components/BarChart';
import type { Dashboard } from '../types';

const STATUS_LABELS: Record<string, string> = {
  new: 'New',
  open: 'Open',
  pending: 'Pending',
  resolved: 'Resolved',
  closed: 'Closed',
};

/**
 * One shared dashboard — the API applies no role scoping (see docs/decisions.md), so this
 * page shows the same numbers to every signed-in user, agent or supervisor alike.
 */
export function DashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<Dashboard>('/api/dashboard')
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the dashboard'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="muted">Loading…</p>;

  if (error || !data) {
    return <div className="error-message">{error || 'Could not load the dashboard'}</div>;
  }

  const statusItems = Object.entries(STATUS_LABELS).map(([key, label]) => ({
    label,
    count: data.by_status[key as keyof typeof data.by_status] ?? 0,
  }));

  const agentItems = data.by_agent.map((row) => ({ label: row.agent.name, count: row.count }));

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Dashboard</h2>
          <p className="page-subtitle">How the queue looks right now.</p>
        </div>
      </header>

      <div className="stat-grid">
        <StatTile label="Open" value={data.open_count} />
        <StatTile label="Pending on customer" value={data.pending_count} />
        <StatTile label="Resolved this week" value={data.resolved_this_week} />
        <StatTile label="Breaching" value={data.breaching_count} tone="warning" />
      </div>

      <div className="dashboard-grid">
        <section className="dashboard-panel">
          <h3>By status</h3>
          <HorizontalBars items={statusItems} />
        </section>

        <section className="dashboard-panel">
          <h3>By agent</h3>
          <HorizontalBars items={agentItems} />
        </section>
      </div>

      <section className="dashboard-panel">
        <h3>Resolved per week — last 8 weeks</h3>
        <WeeklyBarChart weeks={data.resolved_per_week} />
      </section>
    </div>
  );
}
