import type { Period } from '@leash/shared';

/**
 * Calendar periods in an IANA time zone, computed with the runtime's tz data
 * (no extra dependency). Weeks run Monday 00:00 to Monday 00:00; months from
 * the 1st. All returned instants are UTC Dates.
 */

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday!]!,
  };
}

/** Offset of `timeZone` from UTC at `date`, in ms (positive east of UTC). */
function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The UTC instant at which the wall clock in `timeZone` reads the given local
 * date at 00:00. If midnight does not exist (a DST gap at midnight), returns
 * the first instant of that local day.
 */
export function startOfLocalDay(year: number, month: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day);
  let t = guess - offsetMs(new Date(guess), timeZone);
  const second = offsetMs(new Date(t), timeZone);
  if (guess - second !== t) t = guess - second;
  // In a gap the computed instant lands on the previous day; step forward to the new day.
  const p = zonedParts(new Date(t), timeZone);
  if (p.day !== new Date(guess).getUTCDate()) t += 3_600_000;
  return new Date(t);
}

/** Calendar-date arithmetic on (year, month, day) triples, independent of time zones. */
function addDays(y: number, m: number, d: number, days: number): [number, number, number] {
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
}

export interface PeriodBounds {
  start: Date;
  end: Date;
}

export function periodBounds(at: Date, period: Period, timeZone: string): PeriodBounds {
  const p = zonedParts(at, timeZone);
  let start: [number, number, number];
  let end: [number, number, number];
  switch (period) {
    case 'day':
      start = [p.year, p.month, p.day];
      end = addDays(p.year, p.month, p.day, 1);
      break;
    case 'week': {
      const sinceMonday = (p.weekday + 6) % 7;
      start = addDays(p.year, p.month, p.day, -sinceMonday);
      end = addDays(...start, 7);
      break;
    }
    case 'month':
      start = [p.year, p.month, 1];
      end = p.month === 12 ? [p.year + 1, 1, 1] : [p.year, p.month + 1, 1];
      break;
  }
  return { start: startOfLocalDay(...start, timeZone), end: startOfLocalDay(...end, timeZone) };
}

export const PERIODS: readonly Period[] = ['day', 'week', 'month'];
