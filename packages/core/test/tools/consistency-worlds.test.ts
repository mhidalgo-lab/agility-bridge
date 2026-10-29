// SPDX-License-Identifier: Apache-2.0
// The consistency contract on the worlds where branches return early (P6-38, L-032, L-318): no rows at all, a workspace
// whose projects list nothing, a grant that denies asset types, and a grant without the sibling tools. consistency.test.ts
// runs the same checks on the shared world, where every list has rows; a tool that returns before it validates its input
// (the empty `list_members` skipped the cursor check) only shows here.
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, type ToolContext } from '../../src/index.ts';
import { CORE_TOOLS } from '../../src/tools/index.ts';

// The write tools have their own tests (writes-wave1.test.ts, and the write worst cases below): they need an approval.
const READ_TOOLS = CORE_TOOLS.filter((t) => t.kind === 'read');

import type { FakeAgilityOptions } from '../harness/index.ts';
import { advertisedSchemas } from '../harness/lint.ts';
import { costFakeOptions } from './cost-world.ts';
import { rig as baseRig, SIBLINGS, s, text, toolByName } from './reports-world.ts';
import { WORST_CASES } from './worst-case.ts';

type Result = Record<string, unknown>;
const code = (r: Result): string | undefined =>
  (r['_meta'] as Record<string, { code?: string } | undefined> | undefined)?.['agility-bridge/error']?.code;
const inputNames = (name: string): string[] =>
  Object.keys((toolByName(name).inputSchema as unknown as { shape: Record<string, unknown> }).shape);
const outputProps = (name: string): Record<string, { type?: string }> =>
  (advertisedSchemas(toolByName(name)).output?.['properties'] ?? {}) as Record<string, { type?: string }>;

const ALL = READ_TOOLS.map((t) => t.name);
const limits = { ...DEFAULT_LIMITS, attachmentDownload: true, reports: true };

/** The tools some report reads through; the reports alone are granted in the last world. */
const SIBLING_NAMES = new Set(Object.values(SIBLINGS).flat());

interface World {
  readonly label: string;
  readonly fake: Partial<FakeAgilityOptions>;
  readonly ctx: Partial<ToolContext>;
  /** Tools registered; the others are not granted. */
  readonly granted: readonly string[];
}

const WORLDS: readonly World[] = [
  { label: 'no rows at all', fake: { assets: {}, history: {} }, ctx: { limits }, granted: ALL },
  {
    label: 'a workspace whose projects list nothing',
    fake: costFakeOptions(),
    ctx: { limits, projects: { allowed: ['Scope:9999'], includeChildren: false } },
    granted: ALL,
  },
  {
    label: 'a grant that denies work item types',
    fake: costFakeOptions(),
    ctx: { limits, assetTypes: { deny: ['Story', 'Defect', 'Epic', 'Timebox', 'Member', 'Team'] } },
    granted: ALL,
  },
  {
    label: 'a grant without the sibling tools of its reports',
    fake: costFakeOptions(),
    ctx: { limits },
    granted: ALL.filter((n) => !SIBLING_NAMES.has(n)),
  },
];

const rigFor = (w: World) => baseRig({ fake: w.fake });
const run = (w: World, name: string, args: Record<string, unknown>) =>
  rigFor(w).call(name, args, { granted: w.granted, ctx: w.ctx });

describe.each(WORLDS)('on $label', (w) => {
  const tools = w.granted.filter((n) => ALL.includes(n));

  it('a cursor that is not ours is refused first, on every paged tool', async () => {
    let n = 0;
    for (const name of tools) {
      if (!inputNames(name).includes('cursor')) continue;
      n++;
      const r = await run(w, name, { ...(WORST_CASES[name]?.args ?? {}), cursor: 'garbage' });
      expect(code(r), `${name}: ${text(r).slice(0, 160)}`).toBe('AB_INPUT_INVALID');
    }
    expect(n).toBeGreaterThan(0);
  });

  it('a value the schema refuses is refused the same way', async () => {
    for (const name of tools) {
      if (!inputNames(name).includes('limit')) continue;
      const r = await run(w, name, { ...(WORST_CASES[name]?.args ?? {}), limit: 0 });
      expect(code(r), name).toBe('AB_INPUT_INVALID');
    }
  });

  it('shared result keys are declared, partial says why and nextCursor stays with a cursor', async () => {
    const shared: Record<string, string> = {
      nextCursor: 'string',
      truncated: 'boolean',
      partial: 'boolean',
      notes: 'array',
      hiddenOutsideScope: 'boolean',
    };
    for (const name of tools) {
      const r = await run(w, name, WORST_CASES[name]?.args ?? {});
      const sc = s(r) ?? {};
      for (const key of Object.keys(sc))
        if (key in shared) expect(outputProps(name)[key]?.type, `${name}: ${key} declared`).toBe(shared[key]);
      if (sc.partial === true) expect(sc.notes?.length ?? 0, `${name}: partial says why`).toBeGreaterThan(0);
      if (sc.nextCursor !== undefined) expect(inputNames(name)).toContain('cursor');
    }
  });

  it('a denied or empty answer carries no rows and an error has one code', async () => {
    for (const name of tools) {
      const r = await run(w, name, WORST_CASES[name]?.args ?? {});
      if (r['isError'] === true) {
        expect(code(r), `${name}: ${text(r).slice(0, 160)}`).toMatch(/^AB_[A-Z_]+$/);
        expect(s(r)?.items ?? [], `${name}: an error returns no rows`).toEqual([]);
      }
    }
  });
});
