import { Link } from 'react-router-dom';

export interface Stat {
  label: string;
  value: number;
  /** Where this number goes when followed, already filtered to what it counts. */
  to?: string;
  /** The link's own words. A link has to describe what is actually at the end of
   *  it: "work through these" pointing at an empty page is a lie. */
  linkLabel?: string;
  /** A short qualifier under the label, when the number needs one to be honest. */
  note?: string;
  /** The one figure that is a call to action rather than a status report. */
  lead?: boolean;
}

/**
 * The headline numbers, as one divided strip rather than a row of matching cards.
 *
 * Four identical bordered boxes give four numbers the same weight, which is
 * wrong: three of them describe the queue and one of them is a thing somebody
 * has to go and do. The strip keeps them on one rule and lets the breaching
 * count carry the emphasis.
 */
export function StatStrip({ items }: { items: Stat[] }) {
  return (
    <div className="stat-strip">
      {items.map((item) => (
        <div key={item.label} className={`stat-item${item.lead ? ' stat-item-lead' : ''}`}>
          <span className="stat-value">{item.value}</span>
          <span className="stat-label">{item.label}</span>
          {item.note && <span className="stat-note">{item.note}</span>}
          {item.to && item.value > 0 && (
            <Link className="stat-link" to={item.to}>
              {item.linkLabel ?? 'Open the list'}
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}
