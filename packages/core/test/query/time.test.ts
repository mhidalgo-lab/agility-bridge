// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { cursorBinding, decodeCursor, encodeCursor, parseTimeRange } from '../../src/index.ts';
import { makeContext } from '../harness/index.ts';

// Wednesday 2026-10-21 12:00 UTC.
const NOW = Date.parse('2026-10-21T12:00:00Z');
const range = (text: string, now = NOW, max = 366) => parseTimeRange(text, now, max);

describe('parseTimeRange (L-061)', () => {
  it.each([
    ['today', '2026-10-21T00:00:00.000Z', '2026-10-21T12:00:00.000Z'],
    ['yesterday', '2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z'],
    ['this week', '2026-10-19T00:00:00.000Z', '2026-10-21T12:00:00.000Z'],
    ['previous week', '2026-10-12T00:00:00.000Z', '2026-10-19T00:00:00.000Z'],
    ['last week', '2026-10-14T12:00:00.000Z', '2026-10-21T12:00:00.000Z'],
    ['this month', '2026-10-01T00:00:00.000Z', '2026-10-21T12:00:00.000Z'],
    ['previous month', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
    ['last month', '2026-09-21T12:00:00.000Z', '2026-10-21T12:00:00.000Z'],
    ['last 14 days', '2026-10-07T12:00:00.000Z', '2026-10-21T12:00:00.000Z'],
    ['Last 3 Hours', '2026-10-21T09:00:00.000Z', '2026-10-21T12:00:00.000Z'],
    ['since 2026-10-01', '2026-10-01T00:00:00.000Z', '2026-10-21T12:00:00.000Z'],
    ['2026-10-01 to 2026-10-15', '2026-10-01T00:00:00.000Z', '2026-10-16T00:00:00.000Z'],
    [
      '2026-10-01T08:00:00-03:00 to 2026-10-02T00:00:00Z',
      '2026-10-01T11:00:00.000Z',
      '2026-10-02T00:00:00.000Z',
    ],
  ])('%s', (text, since, until) => expect(range(text)).toEqual({ since, until }));

  it('starts weeks on Monday also on Sunday and Monday themselves', () => {
    expect(range('this week', Date.parse('2026-10-25T23:00:00Z')).since).toBe('2026-10-19T00:00:00.000Z');
    expect(range('this week', Date.parse('2026-10-19T00:30:00Z')).since).toBe('2026-10-19T00:00:00.000Z');
  });

  it('handles the year boundary for the previous month', () => {
    expect(range('previous month', Date.parse('2027-01-10T00:00:00Z'))).toEqual({
      since: '2026-12-01T00:00:00.000Z',
      until: '2027-01-01T00:00:00.000Z',
    });
  });

  it.each([
    'next week',
    'last -3 days',
    '2026-02-30 to 2026-03-01',
    '2026-10-15 to 2026-10-01',
    '2026-10-01T10:00 to 2026-10-02',
    '',
  ])('refuses %j', (text) =>
    expect(() => range(text)).toThrow(/time_range|not a valid date|not a date|ends before/),
  );

  it('refuses long input before any regular expression runs', () => {
    const t = performance.now();
    expect(() => range(`2026-10-01${' '.repeat(100_000)}to 2026-10-02`)).toThrow(/too long/);
    expect(performance.now() - t).toBeLessThan(100);
  });

  it('refuses windows above the limit with AB_LIMIT_QUERY', () => {
    expect(() => range('last 400 days')).toThrow(/maxTimeRangeDays/);
    expect(() => range('last 30 days', NOW, 7)).toThrow(/at most 7 days/);
  });
});

describe('cursors', () => {
  it('round-trips the offset and window, and refuses another binding or tampering', async () => {
    const ctx = makeContext({ projects: { allowed: ['Scope:1'], includeChildren: true } });
    const b = await cursorBinding(ctx, 'list_defects', { status: ['Open'] });
    const window = { since: '2026-10-01T00:00:00.000Z', until: '2026-10-21T00:00:00.000Z' };
    const c = encodeCursor(b, { offset: 25, window });
    expect(decodeCursor(c, b)).toEqual({ offset: 25, window });
    const other = await cursorBinding(ctx, 'list_defects', { status: ['Done'] });
    expect(() => decodeCursor(c, other)).toThrow(/does not belong/);
    const otherProjects = await cursorBinding(
      makeContext({ projects: { allowed: ['Scope:2'], includeChildren: true } }),
      'list_defects',
      { status: ['Open'] },
    );
    expect(otherProjects).not.toBe(b);
    for (const bad of ['', '!!!', `${c}x`, encodeCursor(b, { offset: 999_999 }), 'eyJ2IjoxfQ']) {
      expect(() => decodeCursor(bad, b)).toThrow(/does not belong/);
    }
  });

  it('binds key order independently', async () => {
    const ctx = makeContext();
    expect(await cursorBinding(ctx, 't', { a: 1, b: 2 })).toBe(await cursorBinding(ctx, 't', { b: 2, a: 1 }));
  });
});
