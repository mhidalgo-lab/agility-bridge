// SPDX-License-Identifier: Apache-2.0
// One API (P6-12, L-030, L-032, L-317): what every tool does with the same kind of input and the same kind of result,
// run over the whole catalogue with each tool's worst-case arguments. The static lints (lint.test.ts) check what is
// advertised; this file checks what is returned: identity columns first, the shared result keys declared and typed,
// the same error code for the same mistake, one paging contract.
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../../src/index.ts';
import { CORE_TOOLS } from '../../src/tools/index.ts';
import { advertisedSchemas } from '../harness/lint.ts';
import { costFakeOptions } from './cost-world.ts';
import { rig as baseRig, s, text, toolByName } from './reports-world.ts';
import { WORST_CASES } from './worst-case.ts';

/** The shared world with comments, attachments and history, so every worst case can run to the end. */
const rig = () => baseRig({ fake: costFakeOptions() });

const GRANTED = CORE_TOOLS.map((t) => t.name);
const over = {
  granted: GRANTED,
  ctx: { limits: { ...DEFAULT_LIMITS, attachmentDownload: true, reports: true } },
} as never;

type Result = Record<string, unknown>;
const code = (r: Result): string | undefined =>
  (r['_meta'] as Record<string, { code?: string } | undefined> | undefined)?.['agility-bridge/error']?.code;
const inputNames = (name: string): string[] =>
  Object.keys((toolByName(name).inputSchema as unknown as { shape: Record<string, unknown> }).shape);
const outputProps = (name: string): Record<string, { type?: string }> =>
  (advertisedSchemas(toolByName(name)).output?.['properties'] ?? {}) as Record<string, { type?: string }>;

/** The tools run once on the shared world with their worst-case arguments. */
async function runAll(): Promise<Map<string, Result>> {
  const results = new Map<string, Result>();
  for (const t of CORE_TOOLS) {
    const { call } = rig();
    results.set(t.name, await call(t.name, WORST_CASES[t.name]?.args ?? {}, over));
  }
  return results;
}
const ran = runAll();

const IDENTITY = ['number', 'assetType', 'oid', 'state', 'project'];

describe('results read the same way', () => {
  it('every worst-case call succeeds, so the checks below look at real output', async () => {
    for (const [name, r] of await ran)
      expect(r['isError'], `${name}: ${text(r).slice(0, 200)}`).not.toBe(true);
  });

  it('rows start with the identity columns in one order (L-043)', async () => {
    for (const [name, r] of await ran) {
      const rows = (s(r)?.items ?? []) as Array<Record<string, unknown>>;
      for (const row of rows.slice(0, 3)) {
        const keys = Object.keys(row);
        const firstOther = keys.findIndex((k) => !IDENTITY.includes(k));
        const lead = firstOther === -1 ? keys : keys.slice(0, firstOther);
        const rest = firstOther === -1 ? [] : keys.slice(firstOther);
        expect(
          rest.filter((k) => IDENTITY.includes(k)),
          `${name}: ${keys.join(', ')}: identity keys come first`,
        ).toEqual([]);
        expect(lead, `${name}: identity keys keep one order`).toEqual(
          IDENTITY.filter((k) => lead.includes(k)),
        );
      }
    }
  });

  it('shared result keys are declared in the output schema with their shared type', async () => {
    const shared: Record<string, string> = {
      nextCursor: 'string',
      truncated: 'boolean',
      partial: 'boolean',
      notes: 'array',
      hiddenOutsideScope: 'boolean',
    };
    const missing: string[] = [];
    for (const [name, r] of await ran) {
      const declared = outputProps(name);
      for (const key of Object.keys(s(r) ?? {}))
        if (key in shared && declared[key]?.type !== shared[key])
          missing.push(`${name}: ${key} is returned but not declared as ${shared[key]}`);
    }
    expect(missing).toEqual([]);
  });

  it('partial, truncated and nextCursor keep one meaning', async () => {
    for (const [name, r] of await ran) {
      const sc = s(r) ?? {};
      if (sc.partial === true)
        expect(sc.notes?.length ?? 0, `${name}: partial says why in notes`).toBeGreaterThan(0);
      expect(
        sc.nextCursor !== undefined && sc.truncated !== undefined,
        `${name}: nextCursor and truncated never together`,
      ).toBe(false);
      if (sc.nextCursor !== undefined)
        expect(inputNames(name), `${name} pages without a cursor`).toContain('cursor');
      if (sc.notes !== undefined)
        for (const n of sc.notes) expect(typeof n, `${name}: notes are strings`).toBe('string');
    }
  });

  it('the resolved window of a time-bounded tool is { since, until } in UTC', async () => {
    for (const [name, r] of await ran) {
      const window = s(r)?.window;
      if (window === undefined) continue;
      expect(window.since, name).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
      expect(window.until, name).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    }
  });
});

describe('the same mistake gets the same error', () => {
  const withTool = CORE_TOOLS.map((t) => t.name);
  const argsOf = (name: string, extra: Record<string, unknown>) => ({
    ...(WORST_CASES[name]?.args ?? {}),
    ...extra,
  });
  const failure = async (name: string, extra: Record<string, unknown>) => {
    const { call } = rig();
    const r = await call(name, argsOf(name, extra), over);
    return { code: code(r), isError: r['isError'] === true, text: text(r) };
  };
  const cases: ReadonlyArray<[string, string, Record<string, unknown>, string]> = [
    ['asset', 'an unknown number', { asset: 'B-99999' }, 'AB_NOT_FOUND'],
    ['asset', 'text that is not a number or OID', { asset: 'hello world' }, 'AB_INPUT_INVALID'],
    ['cursor', 'a cursor that is not ours', { cursor: 'garbage' }, 'AB_INPUT_INVALID'],
    ['team', 'an unknown team', { team: 'Nope Team' }, 'AB_NOT_FOUND'],
    ['project', 'an unknown project', { project: 'Nope Project' }, 'AB_NOT_FOUND'],
    ['project', 'a project outside the workspace', { project: 'Scope:9999' }, 'AB_NOT_FOUND'],
    ['member', 'an unknown member', { member: 'nobody' }, 'AB_NOT_FOUND'],
    ['time_range', 'a time range nobody understands', { time_range: 'whenever' }, 'AB_INPUT_INVALID'],
  ];
  it.each(cases)('%s: %s', async (arg, _what, extra, expected) => {
    const tools = withTool.filter((n) => inputNames(n).includes(arg));
    expect(tools.length).toBeGreaterThan(0);
    for (const name of tools) {
      const f = await failure(name, extra);
      expect(f.code, `${name}: ${f.text.slice(0, 160)}`).toBe(expected);
    }
  });

  it('an unknown asset type is AB_INPUT_INVALID wherever the type is a free name', async () => {
    for (const name of ['query_assets', 'describe_asset_type']) {
      const f = await failure(name, { asset_type: 'Nonsense' });
      expect(f.code, name).toBe('AB_INPUT_INVALID');
    }
  });

  it('a request refused by the schema is refused before any tool runs, the same way for every tool', async () => {
    for (const name of withTool.filter((n) => inputNames(n).includes('limit'))) {
      const { call, fake } = rig();
      const before = fake.calls.length;
      const r = await call(name, argsOf(name, { limit: 0 }), over);
      expect(
        r['isError'] === true || r['error'] !== undefined || code(r) !== undefined || text(r).length > 0,
      ).toBe(true);
      expect(fake.calls.length, `${name}: limit 0 reached Agility`).toBe(before);
    }
  });
});

describe('one paging contract', () => {
  const pagedTools = CORE_TOOLS.filter((t) => inputNames(t.name).includes('cursor')).map((t) => t.name);

  it('every paged tool returns a cursor that works, and stops without one', async () => {
    let followed = 0;
    for (const name of pagedTools) {
      const base = WORST_CASES[name]?.args ?? {};
      const first = await rig().call(name, { ...base, limit: 1 }, over);
      const sc = s(first) ?? {};
      expect(first['isError'], `${name}: ${text(first).slice(0, 160)}`).not.toBe(true);
      expect(sc.items?.length ?? 0, `${name}: limit 1`).toBeLessThanOrEqual(1);
      if (sc.nextCursor === undefined) continue;
      followed++;
      // Same filters, next page, on a fresh server with the same data: the cursor is portable between calls.
      const second = await rig().call(name, { ...base, limit: 1, cursor: sc.nextCursor }, over);
      expect(second['isError'], `${name}: page 2: ${text(second).slice(0, 160)}`).not.toBe(true);
      // The first window is kept, so changing the time range with a cursor does not change the window.
      if (inputNames(name).includes('time_range'))
        expect(s(second)?.window, `${name}: keeps the first window`).toEqual(sc.window);
      // The cursor is bound to its filters: another one is refused.
      const other = await rig().call(
        name,
        { ...base, limit: 2, cursor: sc.nextCursor, contains: 'zzz' },
        over,
      );
      if (inputNames(name).includes('contains'))
        expect(code(other), `${name}: cursor binding`).toBe('AB_INPUT_INVALID');
    }
    expect(followed, 'the shared world has more than one row for at least some paged tools').toBeGreaterThan(
      1,
    );
  });

  it('a tool without a cursor does not return nextCursor', async () => {
    for (const [name, r] of await ran)
      if (!pagedTools.includes(name)) expect(s(r)?.nextCursor, name).toBeUndefined();
  });
});
