/**
 * Two small hand-rolled charts for the dashboard — plain CSS bars sized by percentage of
 * the largest value in the set. No charting library: five status counts, a handful of
 * agents, and eight weeks don't justify a dependency.
 */

interface BarItem {
  label: string;
  count: number;
}

export function HorizontalBars({ items }: { items: BarItem[] }) {
  if (items.length === 0) return <p className="muted">Nothing to show yet.</p>;

  const max = Math.max(...items.map((i) => i.count), 1);

  return (
    <ul className="bar-list">
      {items.map((item) => (
        <li key={item.label} className="bar-row">
          <span className="bar-row-label">{item.label}</span>
          <span className="bar-row-track">
            <span className="bar-row-fill" style={{ width: `${(item.count / max) * 100}%` }} />
          </span>
          <span className="bar-row-value">{item.count}</span>
        </li>
      ))}
    </ul>
  );
}

function shortWeekLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function WeeklyBarChart({ weeks }: { weeks: { week_start: string; count: number }[] }) {
  const max = Math.max(...weeks.map((w) => w.count), 1);

  return (
    <div className="week-chart">
      {weeks.map((week) => (
        <div key={week.week_start} className="week-chart-col">
          <span className="week-chart-count">{week.count}</span>
          <div className="week-chart-bar-track">
            <div
              className="week-chart-bar"
              style={{ height: `${(week.count / max) * 100}%` }}
              title={`${week.count} resolved, week of ${shortWeekLabel(week.week_start)}`}
            />
          </div>
          <span className="week-chart-label">{shortWeekLabel(week.week_start)}</span>
        </div>
      ))}
    </div>
  );
}
