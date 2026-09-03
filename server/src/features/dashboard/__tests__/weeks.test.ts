import { describe, it, expect } from 'vitest';
import { isoDate, lastNWeekStarts, startOfWeekUtc } from '../weeks.js';

describe('startOfWeekUtc', () => {
  it('finds the Monday of the same week for any day in it', () => {
    // Wednesday 2026-09-02 → Monday 2026-08-31.
    expect(isoDate(startOfWeekUtc(new Date('2026-09-02T15:00:00Z')))).toBe('2026-08-31');
    // Sunday, the last day of an ISO week → the Monday that started it, not the next one.
    expect(isoDate(startOfWeekUtc(new Date('2026-09-06T23:59:00Z')))).toBe('2026-08-31');
    // Monday itself → unchanged.
    expect(isoDate(startOfWeekUtc(new Date('2026-08-31T00:00:00Z')))).toBe('2026-08-31');
  });

  it('crosses a month and year boundary correctly', () => {
    expect(isoDate(startOfWeekUtc(new Date('2026-01-01T00:00:00Z')))).toBe('2025-12-29');
  });
});

describe('lastNWeekStarts', () => {
  it('returns n consecutive Mondays, oldest first, ending with the current week', () => {
    const starts = lastNWeekStarts(8, new Date('2026-09-02T12:00:00Z'));

    expect(starts).toHaveLength(8);
    expect(isoDate(starts[7])).toBe('2026-08-31'); // this week
    expect(isoDate(starts[0])).toBe('2026-07-13'); // 7 weeks earlier

    for (let i = 1; i < starts.length; i++) {
      expect(starts[i].getTime() - starts[i - 1].getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    }
  });
});
