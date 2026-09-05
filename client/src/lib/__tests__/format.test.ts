import { describe, it, expect } from 'vitest';
import { categoryLabel, duration, timeAgo } from '../format';

const NOW = new Date('2026-09-04T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe('timeAgo', () => {
  it('describes recent and older timestamps', () => {
    expect(timeAgo(ago(5_000), NOW)).toBe('just now');
    expect(timeAgo(ago(5 * 60_000), NOW)).toBe('5m ago');
    expect(timeAgo(ago(3 * 3600_000), NOW)).toBe('3h ago');
    expect(timeAgo(ago(4 * 86400_000), NOW)).toBe('4d ago');
  });

  it('falls back to a date once past a month', () => {
    expect(timeAgo(ago(60 * 86400_000), NOW)).toMatch(/\d/);
  });

  it('says "unknown" for an unparseable timestamp', () => {
    // Otherwise the literal text "Invalid Date" is rendered into the page, which reads as
    // a broken record rather than as missing information.
    expect(timeAgo('not-a-date', NOW)).toBe('unknown');
    expect(timeAgo('', NOW)).toBe('unknown');
  });

  it('treats a future timestamp as "just now" rather than negative time', () => {
    // A timestamp ahead of the browser's clock is skew between it and the server, not
    // something the reader can act on — "-3m ago" would be worse than saying nothing.
    expect(timeAgo(ago(-3 * 60_000), NOW)).toBe('just now');
    expect(timeAgo(ago(-10 * 86400_000), NOW)).toBe('just now');
  });
});

describe('duration', () => {
  it('formats minutes, hours and days', () => {
    expect(duration(0)).toBe('0m');
    expect(duration(59)).toBe('59m');
    expect(duration(60)).toBe('1h');
    expect(duration(1440)).toBe('1d');
    expect(duration(1501)).toBe('1d 1h 1m');
  });

  it('uses the absolute value, since a breach is rendered as time overdue', () => {
    expect(duration(-90)).toBe('1h 30m');
  });
});

describe('categoryLabel', () => {
  it('labels the known categories and passes anything else through', () => {
    expect(categoryLabel('how_to')).toBe('How-to');
    expect(categoryLabel('bug')).toBe('Bug');
    expect(categoryLabel('something_new')).toBe('something_new');
  });
});
