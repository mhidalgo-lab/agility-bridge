// SPDX-License-Identifier: Apache-2.0
// One time model for the whole server (L-061): UTC; weeks start on Monday; "last N days/weeks/months" and "last
// week/month" are rolling windows (7 and 30 days), "this/previous week/month" are calendar periods; a date-only end
// includes the whole day. Windows are half-open: `since` ≤ t < `until`.
import { invalid, limitError } from './limits.ts';

export interface TimeWindow {
  /** ISO 8601 UTC, inclusive. */
  readonly since: string;
  /** ISO 8601 UTC, exclusive. */
  readonly until: string;
}

const DAY = 86_400_000;
const UNIT_MS: Readonly<Record<string, number>> = {
  hour: 3_600_000,
  day: DAY,
  week: 7 * DAY,
  month: 30 * DAY,
};

const startOfDay = (t: number): number => Math.floor(t / DAY) * DAY;
/** Monday 00:00 UTC of the week containing `t`. */
const startOfWeek = (t: number): number => {
  const day = startOfDay(t);
  const weekday = (new Date(day).getUTCDay() + 6) % 7;
  return day - weekday * DAY;
};
const startOfMonth = (t: number, delta = 0): number => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1);
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A date (`YYYY-MM-DD`, start of that UTC day) or a zoned timestamp; `end` makes a date-only value exclusive-next-day. */
export function parseInstant(text: string, end = false): number {
  const s = text.trim();
  if (DATE_RE.test(s)) {
    const t = Date.parse(`${s}T00:00:00Z`);
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s)
      throw invalid(`"${s}" is not a valid date.`);
    return end ? t + DAY : t;
  }
  if (DATETIME_RE.test(s)) {
    const t = Date.parse(s.replace(/(\.\d{3})\d+/, '$1'));
    if (!Number.isNaN(t)) return t;
  }
  throw invalid(
    `"${s}" is not a date (YYYY-MM-DD) or an ISO 8601 timestamp with a zone.`,
    'Times are UTC: use 2026-10-01 or 2026-10-01T12:00:00Z.',
  );
}

const iso = (t: number): string => new Date(t).toISOString();

/**
 * Parses a `time_range` (tool conventions): `today`, `yesterday`, `this week|month`, `previous week|month`, `last week`,
 * `last month`, `last N hours|days|weeks|months`, `since <date>`, `<date> to <date>`. Windows longer than
 * `maxDays` and windows that end before they start are refused.
 */
export function parseTimeRange(text: string, now: number, maxDays: number): TimeWindow {
  const s = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (s.length > 100) throw invalid('time_range is too long.');
  let since: number;
  let until = now;
  const rolling = /^last (\d{1,4}) (hour|day|week|month)s?$/.exec(s);
  const sinceMatch = /^since (\S+)$/.exec(s);
  const between = /^(\S+) to (\S+)$/.exec(s);
  if (s === 'today') since = startOfDay(now);
  else if (s === 'yesterday') {
    since = startOfDay(now) - DAY;
    until = startOfDay(now);
  } else if (s === 'this week') since = startOfWeek(now);
  else if (s === 'previous week') {
    since = startOfWeek(now) - 7 * DAY;
    until = startOfWeek(now);
  } else if (s === 'this month') since = startOfMonth(now);
  else if (s === 'previous month') {
    since = startOfMonth(now, -1);
    until = startOfMonth(now);
  } else if (s === 'last week') since = now - 7 * DAY;
  else if (s === 'last month') since = now - 30 * DAY;
  else if (rolling !== null) since = now - Number(rolling[1]) * (UNIT_MS[rolling[2] as string] as number);
  else if (sinceMatch !== null) since = parseInstant(text.trim().slice(6));
  else if (between !== null) {
    const [from = '', to = ''] = text.trim().split(/\s+to\s+/i);
    since = parseInstant(from);
    until = parseInstant(to, true);
  } else {
    throw invalid(
      `time_range "${text.slice(0, 100)}" is not understood.`,
      'Use e.g. "last 14 days", "this week", "previous month", "since 2026-10-01" or "2026-10-01 to 2026-10-15" (UTC).',
    );
  }
  if (until <= since) throw invalid('time_range ends before it starts.');
  const days = (until - since) / DAY;
  if (days > maxDays) throw limitError('maxTimeRangeDays', maxDays, 'days', Math.ceil(days));
  return { since: iso(since), until: iso(until) };
}
