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

interface WeeklyBarChartProps {
  weeks: { week_start: string; count: number }[];
  /** Present only on the 8-week overview: a bar becomes a button when there is
   *  somewhere for clicking it to lead. The single-week drill-down has no further
   *  level to descend into, so it renders the same chart shape with no handler. */
  onSelectWeek?: (weekStart: string) => void;
}

export function WeeklyBarChart({ weeks, onSelectWeek }: WeeklyBarChartProps) {
  const max = Math.max(...weeks.map((w) => w.count), 1);

  return (
    <div className="week-chart">
      {weeks.map((week) => {
        const bar = (
          <>
            <span className="week-chart-count tabular">{week.count}</span>
            <div className="week-chart-bar-track">
              <div
                className="week-chart-bar"
                style={{ height: `${(week.count / max) * 100}%` }}
              />
            </div>
            <span className="week-chart-label">{shortWeekLabel(week.week_start)}</span>
          </>
        );

        return (
          <div key={week.week_start} className="week-chart-col">
            {onSelectWeek ? (
              <button
                type="button"
                className="week-chart-col-button"
                onClick={() => onSelectWeek(week.week_start)}
                title={`${week.count} resolved, week of ${shortWeekLabel(week.week_start)}. Show the day-by-day breakdown.`}
              >
                {bar}
              </button>
            ) : (
              bar
            )}
          </div>
        );
      })}
    </div>
  );
}

function shortDayLabel(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
}

/** The single-week drill-down: the same shape as WeeklyBarChart, one bar per day
 *  Monday through Sunday rather than one bar per week. */
export function DailyBarChart({ days }: { days: { date: string; count: number }[] }) {
  const max = Math.max(...days.map((d) => d.count), 1);

  return (
    <div className="week-chart">
      {days.map((day) => (
        <div key={day.date} className="week-chart-col">
          <span className="week-chart-count tabular">{day.count}</span>
          <div className="week-chart-bar-track">
            <div
              className="week-chart-bar"
              style={{ height: `${(day.count / max) * 100}%` }}
              title={`${day.count} resolved, ${shortDayLabel(day.date)} ${shortWeekLabel(day.date)}`}
            />
          </div>
          <span className="week-chart-label">{shortDayLabel(day.date)}</span>
        </div>
      ))}
    </div>
  );
}
