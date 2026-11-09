import { describe, expect, it } from 'vitest';
import { periodBounds, zonedParts } from '../../src/modules/budget/periods.js';

const iso = (d: Date) => d.toISOString();

describe('periodBounds', () => {
  it('computes UTC calendar periods', () => {
    const at = new Date('2026-11-11T15:30:00Z'); // Wednesday
    expect(iso(periodBounds(at, 'day', 'UTC').start)).toBe('2026-11-11T00:00:00.000Z');
    expect(iso(periodBounds(at, 'day', 'UTC').end)).toBe('2026-11-12T00:00:00.000Z');
    expect(iso(periodBounds(at, 'week', 'UTC').start)).toBe('2026-11-09T00:00:00.000Z'); // Monday
    expect(iso(periodBounds(at, 'week', 'UTC').end)).toBe('2026-11-16T00:00:00.000Z');
    expect(iso(periodBounds(at, 'month', 'UTC').start)).toBe('2026-11-01T00:00:00.000Z');
    expect(iso(periodBounds(at, 'month', 'UTC').end)).toBe('2026-12-01T00:00:00.000Z');
  });

  it('treats Sunday as the last day of the week and Monday 00:00 as the first instant', () => {
    expect(iso(periodBounds(new Date('2026-11-15T23:59:59Z'), 'week', 'UTC').start)).toBe(
      '2026-11-09T00:00:00.000Z',
    );
    expect(iso(periodBounds(new Date('2026-11-16T00:00:00Z'), 'week', 'UTC').start)).toBe(
      '2026-11-16T00:00:00.000Z',
    );
  });

  it('uses the policy time zone, not UTC', () => {
    // 2026-11-01 03:00 UTC is still 31 Oct in New York (UTC-4 before DST ends that day).
    const at = new Date('2026-11-01T03:00:00Z');
    expect(iso(periodBounds(at, 'month', 'America/New_York').start)).toBe(
      '2026-10-01T04:00:00.000Z',
    );
    expect(iso(periodBounds(at, 'month', 'UTC').start)).toBe('2026-11-01T00:00:00.000Z');
    // Tokyo is ahead: 2026-11-30 16:00 UTC is already 1 Dec there.
    expect(iso(periodBounds(new Date('2026-11-30T16:00:00Z'), 'month', 'Asia/Tokyo').start)).toBe(
      '2026-11-30T15:00:00.000Z',
    );
  });

  it('handles DST transitions (23- and 25-hour days)', () => {
    // US DST ends 2026-11-01: that day is 25 hours long in New York.
    const fallBack = periodBounds(new Date('2026-11-01T12:00:00Z'), 'day', 'America/New_York');
    expect(iso(fallBack.start)).toBe('2026-11-01T04:00:00.000Z');
    expect(iso(fallBack.end)).toBe('2026-11-02T05:00:00.000Z');
    // US DST starts 2026-03-08: 23 hours long.
    const springForward = periodBounds(new Date('2026-03-08T12:00:00Z'), 'day', 'America/New_York');
    expect(springForward.end.getTime() - springForward.start.getTime()).toBe(23 * 3_600_000);
    // A week spanning the change is 7 days minus/plus an hour.
    const week = periodBounds(new Date('2026-03-10T12:00:00Z'), 'week', 'America/New_York');
    expect(iso(week.start)).toBe('2026-03-09T04:00:00.000Z');
    const weekWithChange = periodBounds(
      new Date('2026-03-04T12:00:00Z'),
      'week',
      'America/New_York',
    );
    expect(weekWithChange.end.getTime() - weekWithChange.start.getTime()).toBe(
      7 * 86_400_000 - 3_600_000,
    );
  });

  it('handles year boundaries and leap years', () => {
    expect(iso(periodBounds(new Date('2026-12-31T23:00:00Z'), 'month', 'UTC').end)).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    expect(iso(periodBounds(new Date('2028-02-29T10:00:00Z'), 'month', 'UTC').end)).toBe(
      '2028-03-01T00:00:00.000Z',
    );
    // ISO week containing 1 Jan 2027 (a Friday) starts Monday 28 Dec 2026.
    expect(iso(periodBounds(new Date('2027-01-01T10:00:00Z'), 'week', 'UTC').start)).toBe(
      '2026-12-28T00:00:00.000Z',
    );
  });

  it('every instant falls inside its own period', () => {
    for (const tz of [
      'UTC',
      'America/Los_Angeles',
      'Europe/London',
      'Asia/Kolkata',
      'Pacific/Chatham',
    ]) {
      for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 37 * 3_600_000) {
        for (const period of ['day', 'week', 'month'] as const) {
          const { start, end } = periodBounds(new Date(t), period, tz);
          expect(
            start.getTime(),
            `${tz} ${period} ${new Date(t).toISOString()}`,
          ).toBeLessThanOrEqual(t);
          expect(end.getTime()).toBeGreaterThan(t);
        }
      }
    }
  });
});

describe('zonedParts', () => {
  it('reports local wall-clock time and weekday', () => {
    expect(zonedParts(new Date('2026-11-09T23:30:00Z'), 'Asia/Kolkata')).toMatchObject({
      year: 2026,
      month: 11,
      day: 10,
      hour: 5,
      minute: 0,
      weekday: 2,
    });
  });
});
