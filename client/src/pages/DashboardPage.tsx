import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { StatStrip } from '../components/StatStrip';
import { DailyBarChart, HorizontalBars, WeeklyBarChart } from '../components/BarChart';
import { usePageMeta } from '../lib/usePageMeta';
import { useAlerts } from '../context/AlertsContext';
import { useAuth } from '../context/AuthContext';
import type { Dashboard, WeekDetail } from '../types';

const STATUS_LABELS: Record<string, string> = {
  new: 'New',
  open: 'Open',
  pending: 'Pending',
  resolved: 'Resolved',
  closed: 'Closed',
};

/** "Aug 31 – Sep 6", from the Monday the week starts on. */
function formatWeekRange(weekStart: string): string {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${fmt(start)} – ${fmt(end)}`;
}

/**
 * One shared dashboard: the API applies no role scoping (see docs/decisions.md), so this
 * page shows the same numbers to every signed-in user, agent or supervisor alike.
 */
export function DashboardPage() {
  // The breaching count and the alerts list deliberately disagree: a ticket stays
  // breached whether or not somebody has acknowledged it, but an acknowledged one
  // drops off the alerts page. Without knowing how many are still live, this tile
  // cannot describe where its own link goes.
  const { total: activeAlerts } = useAlerts();
  const { user } = useAuth();
  const isSupervisor = user?.role === 'supervisor';
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // Separate from weekDetail itself: selectedWeek toggles which view this panel shows,
  // and stays set for the whole time its own fetch is in flight — checking weekDetail's
  // presence instead would flash the 8-week chart back on for that entire window, since
  // weekDetail is null until the fetch resolves.
  const [selectedWeek, setSelectedWeek] = useState<string | null>(null);
  const [weekDetail, setWeekDetail] = useState<WeekDetail | null>(null);
  const [weekError, setWeekError] = useState('');
  const [weekLoading, setWeekLoading] = useState(false);

  function selectWeek(weekStart: string) {
    setSelectedWeek(weekStart);
    setWeekDetail(null);
    setWeekError('');
    setWeekLoading(true);
    api
      .get<WeekDetail>(`/api/dashboard/week?start=${weekStart}`)
      .then((detail) => setWeekDetail(detail))
      .catch((err) =>
        setWeekError(
          err instanceof ApiError
            ? `That week could not be loaded. ${err.message}`
            : 'That week could not be loaded. Check your connection, then try again.'
        )
      )
      .finally(() => setWeekLoading(false));
  }

  function backToWeeks() {
    setSelectedWeek(null);
  }

  usePageMeta(
    'Dashboard',
    'How the support queue stands right now: open and pending counts, tickets resolved this week, what is breaching its response target, and the split by agent.'
  );

  useEffect(() => {
    api
      .get<Dashboard>('/api/dashboard')
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((err) =>
        setError(
          err instanceof ApiError
            ? `The dashboard could not be loaded. ${err.message}`
            : 'The dashboard could not be loaded. Check your connection and reload the page.'
        )
      )
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <h2>Dashboard</h2>
          </div>
        </header>
        {/* Skeletons in the shape of what is arriving, so the page does not jump
            when it does. */}
        <div className="skeleton-list" aria-hidden="true">
          <div className="skeleton skeleton-tall" />
          <div className="skeleton skeleton-tall" />
        </div>
        <p className="sr-only" role="status">
          Loading the dashboard
        </p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <h2>Dashboard</h2>
          </div>
        </header>
        <div className="error-message" role="alert">
          {error || 'The dashboard could not be loaded. Reload the page to try again.'}
        </div>
      </div>
    );
  }

  // Each row links to the queue already filtered to what it counts, so "13 open" and the
  // list of those thirteen are the same query rather than two things to line up by hand.
  const statusItems = Object.entries(STATUS_LABELS).map(([key, label]) => ({
    label,
    count: data.by_status[key as keyof typeof data.by_status] ?? 0,
    to: `/tickets?status=${key}`,
  }));

  const agentItems = data.by_agent.map((row) => ({
    label: row.agent.name,
    count: row.count,
    to: `/tickets?assignee_id=${encodeURIComponent(row.agent.id)}`,
  }));

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Dashboard</h2>
        </div>
      </header>

      {/* Breaching is listed last but carries the emphasis: the other three
          describe the queue, that one is a thing somebody has to go and do. */}
      <StatStrip
        items={[
          { label: 'Open', value: data.open_count, to: '/tickets?status=open' },
          { label: 'Pending on customer', value: data.pending_count, to: '/tickets?status=pending' },
          { label: 'Resolved this week', value: data.resolved_this_week },
          {
            label: 'Unassigned',
            value: data.unassigned_count,
            // Visible to everyone (this dashboard isn't role-scoped), but only a
            // supervisor can actually reach the page the count is describing.
            ...(isSupervisor ? { to: '/unassigned', linkLabel: 'Route these to an agent' } : {}),
          },
          {
            label: 'Breaching',
            value: data.breaching_count,
            to: '/alerts',
            lead: true,
            ...(activeAlerts > 0
              ? { linkLabel: `Work through ${activeAlerts} still unacknowledged` }
              : {
                note: 'All acknowledged, still past target',
                linkLabel: 'See what was acknowledged',
              }),
          },
        ]}
      />

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
        {selectedWeek ? (
          <>
            <div className="dashboard-panel-header">
              <h3>Week of {formatWeekRange(selectedWeek)}</h3>
              <button type="button" className="btn link-button" onClick={backToWeeks}>
                ← Back to 8 weeks
              </button>
            </div>

            {weekError && (
              <div className="error-message" role="alert">
                {weekError}
              </div>
            )}

            {weekLoading ? (
              <div className="skeleton skeleton-tall" aria-hidden="true" />
            ) : (
              weekDetail && (
                <>
                  <DailyBarChart days={weekDetail.days} />
                  <h4>By agent</h4>
                  {weekDetail.by_agent.length === 0 ? (
                    <p className="muted">Nobody resolved a ticket this week.</p>
                  ) : (
                    <HorizontalBars
                      items={weekDetail.by_agent.map((row) => ({
                        label: row.agent.name,
                        count: row.count,
                        to: `/tickets?assignee_id=${encodeURIComponent(row.agent.id)}`,
                      }))}
                    />
                  )}
                </>
              )
            )}
          </>
        ) : (
          <>
            <h3>Resolved per week, last 8 weeks</h3>
            <WeeklyBarChart weeks={data.resolved_per_week} onSelectWeek={selectWeek} />
          </>
        )}
      </section>
    </div>
  );
}
