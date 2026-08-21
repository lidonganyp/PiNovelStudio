/**
 * UTC 日切范围。
 */
import { describe, expect, it } from 'vitest';
import { lastUtcDays, parseUtcDayRange, previousUtcRange } from './date-range';

describe('parseUtcDayRange', () => {
  it('treats YYYY-MM-DD as inclusive UTC days', () => {
    const range = parseUtcDayRange('2026-08-01', '2026-08-02');
    expect(range.start?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(range.end?.toISOString()).toBe('2026-08-03T00:00:00.000Z');
  });

  it('builds the previous window of the same length', () => {
    const range = parseUtcDayRange('2026-08-08', '2026-08-14');
    const prev = previousUtcRange(range);
    expect(prev.start?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(prev.end?.toISOString()).toBe('2026-08-08T00:00:00.000Z');
  });

  it('returns the last N UTC days ending tomorrow 00:00', () => {
    const range = lastUtcDays(1, new Date('2026-08-21T15:00:00.000Z'));
    expect(range.start?.toISOString()).toBe('2026-08-21T00:00:00.000Z');
    expect(range.end?.toISOString()).toBe('2026-08-22T00:00:00.000Z');
  });
});
