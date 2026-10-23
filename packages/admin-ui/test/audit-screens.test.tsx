// SPDX-License-Identifier: Apache-2.0
// The P4-05 screens against a fake admin API (THREAT_MODEL T13, T17): what the audit and usage screens ask for, the CSV
// cell rules (L-041), cursor and filter parsing, and the truncation notice. The real API, roles and storage are exercised
// in `packages/http-app/test/admin-audit.test.ts`.
import { describe, expect, it } from 'vitest';
import {
  apiQuery,
  auditCsv,
  CSV_COLUMNS,
  csvCell,
  cursorOf,
  detailsText,
  parseCursor,
} from '../src/screens/audit.tsx';
import { parseAudit, parseUsage } from '../src/screens/data.ts';
import { meanMs, percent } from '../src/screens/usage.tsx';
import { type Fake, fakeDeps, get, NOW } from './helpers/fake-deps.ts';

const asAdmin = { 'x-test-session': 'admin' };
const asMember = { 'x-test-session': 'member' };
const NO_FILTER = { range: 'all', kind: '', status: '', action: '', workspaceId: '', userId: '' };

describe('csvCell', () => {
  it('quotes text, doubles quotes and keeps numbers and nulls plain', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(12)).toBe('12');
    expect(csvCell(null)).toBe('');
  });

  it('prefixes every formula trigger, also after white space', () => {
    for (const v of ['=1+1', '+1', '-1', '@x', '\t=1', '\r1', '\n1', ' =1', '  \t+1', ' =1']) {
      expect(csvCell(v), JSON.stringify(v)).toBe(`"'${v}"`);
    }
    for (const v of ['safe', '1=1', 'a-b', 'x @y', '']) expect(csvCell(v), v).toBe(`"${v}"`);
  });
});

describe('auditCsv', () => {
  it('writes the header and one line per row, every text cell quoted', () => {
    const row = parseAudit({
      id: 'r1',
      ts: NOW,
      kind: 'tool_call',
      action: '=cmd',
      status: 'ok',
      assetNumbers: ['B-1', 'B-2'],
      details: { a: '=x' },
      durationMs: 5,
    });
    expect(row).not.toBeNull();
    const text = auditCsv(row ? [row] : []);
    const [header, line] = text.split('\r\n');
    expect(header).toBe(CSV_COLUMNS.join(','));
    expect(line).toContain(`"${new Date(NOW).toISOString()}"`);
    expect(line).toContain(`"'=cmd"`);
    expect(line).toContain('"B-1 B-2"');
    expect(line).toContain(',5,');
    expect(line).toContain('"{""a"":""=x""}"');
    expect(text.endsWith('\r\n')).toBe(true);
  });
});

describe('cursors and filters', () => {
  it('accepts only <ts>.<id> and round-trips', () => {
    expect(parseCursor(cursorOf({ ts: 123, id: 'row-1_a:b' }))).toEqual({ ts: 123, id: 'row-1_a:b' });
    for (const bad of [
      undefined,
      '',
      'abc',
      '12',
      '12.',
      '.x',
      '-1.x',
      '1.x y',
      '1.<x>',
      `${'9'.repeat(16)}.x`,
      `1.${'a'.repeat(129)}`,
    ])
      expect(parseCursor(bad), String(bad)).toBeNull();
  });

  it('turns the range into a lower bound from the server clock and drops empty values', () => {
    expect(apiQuery({ ...NO_FILTER, range: '24h' }, 100_000_000)).toEqual({
      from: String(100_000_000 - 86_400_000),
    });
    expect(
      apiQuery(
        { range: 'all', kind: 'admin', status: 'ok', action: 'x.y', workspaceId: 'w', userId: 'u' },
        5,
      ),
    ).toEqual({ kind: 'admin', status: 'ok', action: 'x.y', workspaceId: 'w', userId: 'u' });
    expect(apiQuery({ ...NO_FILTER, range: '90d' }, 10)).toEqual({ from: '0' });
  });

  it('cuts long details and a timestamp a Date cannot show falls back to the epoch', () => {
    expect(detailsText(null)).toBe('');
    expect(detailsText({ a: 'x'.repeat(1_000) }).length).toBeLessThanOrEqual(301);
    expect(parseAudit({ id: 'r', ts: 9_000_000_000_000_000 })?.ts).toBe(0);
  });
});

describe('usage numbers', () => {
  it('shows ratios and means without a plausible zero for no data', () => {
    expect(percent(1, 4)).toBe('25.0%');
    expect(percent(0, 4)).toBe('0%');
    expect(percent(4, 4)).toBe('100%');
    expect(percent(1, 0)).toBe('—');
    expect(meanMs(450, 3)).toBe('150 ms');
    expect(meanMs(0, 0)).toBe('—');
  });

  it('parses a stats answer field by field and refuses another shape', () => {
    expect(parseUsage({ data: [{ key: 'x', calls: 2, errors: '1' }], scanned: 2, truncated: true })).toEqual({
      rows: [
        {
          key: 'x',
          calls: 2,
          errors: 0,
          denied: 0,
          agilityRequests: 0,
          durationSumMs: 0,
          durationCount: 0,
          maxDurationMs: null,
        },
      ],
      scanned: 2,
      truncated: true,
    });
    expect(parseUsage([])).toBeNull();
    expect(parseUsage(null)).toBeNull();
  });
});

describe('screens', () => {
  const answer = (fake: Fake) => {
    fake.respond = (call) => {
      if (call.path === '/audit/stats')
        return {
          status: 200,
          body: {
            data: [{ key: 'search_assets', calls: 10_000, errors: 0, denied: 0 }],
            scanned: 10_000,
            truncated: true,
          },
        };
      return { status: 200, body: [] };
    };
  };

  it('the usage page says when the statistics read only the newest rows', async () => {
    const fake = fakeDeps();
    answer(fake);
    const html = await (await get(fake, '/admin/usage', asAdmin)).text();
    expect(html).toContain('10,000 newest rows');
    expect(fake.calls.filter((c) => c.path === '/audit/stats')).toHaveLength(1);
    expect(fake.calls.find((c) => c.path === '/audit/stats')?.query).toMatchObject({
      groupBy: 'tool',
      limit: '50',
    });
  });

  it('the audit page asks for one row more than it shows, with a validated cursor, and a member never sends a user filter', async () => {
    const fake = fakeDeps();
    answer(fake);
    await get(fake, '/admin/audit?after=12.abc&user=usr_other&kind=admin', asMember);
    const call = fake.calls.find((c) => c.path === '/audit');
    expect(call?.query).toMatchObject({ limit: '51', afterTs: '12', afterId: 'abc', kind: 'admin' });
    expect(call?.query).not.toHaveProperty('userId');
    // A forged cursor never reaches the API.
    fake.calls.length = 0;
    await get(fake, '/admin/audit?after=1.%3Cscript%3E', asAdmin);
    expect(fake.calls.find((c) => c.path === '/audit')?.query).not.toHaveProperty('afterId');
  });

  it('a member gets no usage page even if the API would answer, and their audit page makes exactly one API read', async () => {
    const fake = fakeDeps();
    answer(fake);
    const usage = await get(fake, '/admin/usage', asMember);
    expect(usage.status).toBe(403);
    expect(await usage.text()).not.toContain('search_assets');
    expect(fake.calls).toEqual([]);
    expect(fake.forbidden).toEqual(['role']);
    await get(fake, '/admin/audit', asMember);
    expect(fake.calls.map((c) => c.path)).toEqual(['/audit']);
  });

  it('a failing API read is an error page, not an empty log', async () => {
    const fake = fakeDeps();
    fake.respond = (call) =>
      call.path === '/audit'
        ? { status: 503, body: { error: { code: 'unavailable', message: 'x' } } }
        : undefined;
    const res = await get(fake, '/admin/audit', asAdmin);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('No entries match');
  });
});
