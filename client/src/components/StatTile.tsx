interface Props {
  label: string;
  value: number;
  tone?: 'default' | 'warning';
}

/** One headline number on the dashboard. */
export function StatTile({ label, value, tone = 'default' }: Props) {
  return (
    <div className={`stat-tile${tone === 'warning' ? ' stat-tile-warning' : ''}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
