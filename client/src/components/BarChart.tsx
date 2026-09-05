/**
 * Two small hand-rolled charts for the dashboard: plain CSS bars sized by percentage of
 * the largest value in the set. No charting library: five status counts, a handful of
 * agents, and eight weeks don't justify a dependency.
 */

import { Link } from 'react-router-dom';

interface BarItem {
  label: string;
  count: number;
  /** Where clicking this row goes: the queue, already filtered to what the row counts. */
  to?: string;
}

/**
 * A row is a link when the caller gives it one, and plain text otherwise.
 *
 * The point of a breakdown is the question it provokes ("which eleven?") and the answer
 * is a queue filtered to exactly that row. Making the row itself the link means the number
 * you clicked and the list you land on are the same query, rather than something to
 * reconstruct by hand out of the filter dropdowns.
 */
export function HorizontalBars({ items }: { items: BarItem[] }) {
  if (items.length === 0) return <p className="muted">Nothing to show yet.</p>;

  const max = Math.max(...items.map((i) => i.count), 1);

  return (
    <ul className="bar-list">
      {items.map((item) => {
        const cells = (
          <>
            <span className="bar-row-label">{item.label}</span>
            <span className="bar-row-track">
              {/* scaleX rather than width: animating width forces layout on
                  every frame, and this row sits in a list of them. */}
              <span
                className="bar-row-fill"
                style={{ transform: `scaleX(${Math.max(item.count / max, 0.01)})` }}
              />
            </span>
            <span className="bar-row-value tabular">{item.count}</span>
          </>
        );

        return (
          <li key={item.label} className="bar-row">
            {/* Linked or not, the three cells sit inside one wrapper so the row's grid has
                the same shape either way and the layout does not depend on the link. */}
            {item.to ? (
              <Link className="bar-row-cells bar-row-link" to={item.to} title={`Show ${item.label} tickets`}>
                {cells}
              </Link>
            ) : (
              <span className="bar-row-cells">{cells}</span>
            )}
          </li>
        );
      })}
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
          <span className="week-chart-count tabular">{week.count}</span>
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
