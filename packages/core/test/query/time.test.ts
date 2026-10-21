// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { bindFixed, cursorBinding, decodeCursor, encodeCursor, parseTimeRange } from '../../src/index.ts';
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
  const refusedAsync = /does not belong/;
  const clocked = (over: Parameters<typeof makeContext>[0] = {}) =>
    makeContext({
      clock: { now: () => NOW },
      projects: { allowed: ['Scope:1'], includeChildren: true },
      ...over,
    });
  const window = { since: '2026-10-01T00:00:00.000Z', until: '2026-10-21T00:00:00.000Z' };

  it('round-trips the offset and window, and refuses another binding or tampering', async () => {
    const ctx = clocked();
    const b = await cursorBinding(ctx, 'list_defects', { status: ['Open'] });
    const c = encodeCursor(await bindFixed(b, { window }), { offset: 25, window });
    expect(await decodeCursor(ctx, c, b)).toEqual({ offset: 25, window });
    const other = await cursorBinding(ctx, 'list_defects', { status: ['Done'] });
    await expect(decodeCursor(ctx, c, other)).rejects.toThrow(refusedAsync);
    const otherProjects = await cursorBinding(
      makeContext({ projects: { allowed: ['Scope:2'], includeChildren: true } }),
      'list_defects',
      { status: ['Open'] },
    );
    expect(otherProjects).not.toBe(b);
    for (const bad of ['', '!!!', `${c}x`, encodeCursor(b, { offset: 999_999 }), 'eyJ2IjoxfQ', 'bnVsbA']) {
      await expect(decodeCursor(ctx, bad, b)).rejects.toThrow(refusedAsync);
    }
  });

  it('refuses an edited window or "now" (P1-18)', async () => {
    const ctx = clocked();
    const b = await cursorBinding(ctx, 'list_defects', {});
    const sealed = await bindFixed(b, { window });
    const wider = { since: '2026-01-01T00:00:00.000Z', until: window.until };
    // The window edited, the binding kept.
    await expect(decodeCursor(ctx, encodeCursor(sealed, { offset: 0, window: wider }), b)).rejects.toThrow(
      refusedAsync,
    );
    // A window added to a cursor that had none.
    await expect(decodeCursor(ctx, encodeCursor(b, { offset: 0, window }), b)).rejects.toThrow(refusedAsync);
    // Re-hashed by hand: still refused above maxTimeRangeDays, and for impossible or non-UTC instants.
    const small = clocked({ limits: { ...makeContext().limits, maxTimeRangeDays: 30 } });
    const forged = encodeCursor(await bindFixed(b, { window: wider }), { offset: 0, window: wider });
    await expect(decodeCursor(small, forged, b)).rejects.toThrow(refusedAsync);
    for (const w of [
      { since: window.until, until: window.since },
      { since: '2026-10-01', until: window.until },
      { since: '2026-10-01T00:00:00+02:00', until: window.until },
    ]) {
      const c = encodeCursor(await bindFixed(b, { window: w }), { offset: 0, window: w });
      await expect(decodeCursor(ctx, c, b)).rejects.toThrow(refusedAsync);
    }
    // "now": kept when recent, refused in the future or older than a day.
    const recent = '2026-10-21T11:00:00.000Z';
    expect(
      await decodeCursor(
        ctx,
        encodeCursor(await bindFixed(b, { now: recent }), { offset: 3, now: recent }),
        b,
      ),
    ).toEqual({ offset: 3, now: recent });
    for (const now of ['2026-10-21T13:00:00.000Z', '2026-10-19T12:00:00.000Z']) {
      const c = encodeCursor(await bindFixed(b, { now }), { offset: 3, now });
      await expect(decodeCursor(ctx, c, b)).rejects.toThrow(refusedAsync);
    }
    const c = encodeCursor(await bindFixed(b, { now: recent }), {
      offset: 3,
      now: '2026-10-21T11:30:00.000Z',
    });
    await expect(decodeCursor(ctx, c, b)).rejects.toThrow(refusedAsync);
  });

  it('binds key order independently', async () => {
    const ctx = makeContext();
    expect(await cursorBinding(ctx, 't', { a: 1, b: 2 })).toBe(await cursorBinding(ctx, 't', { b: 2, a: 1 }));
  });
});
