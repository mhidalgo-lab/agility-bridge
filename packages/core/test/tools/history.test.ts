// SPDX-License-Identifier: Apache-2.0
// P6-05 history tools on a synthetic world: Hist versions served through the fake's override, windows and limits
// refused before any request, scope and allow-list denials without a Hist request, poisoned text, costs.
import { describe, expect, it } from 'vitest';
import {
  buildMcpServer,
  createBudget,
  MetadataService,
  type ToolContext,
  type ToolDefinition,
} from '../../src/index.ts';
import { getAssetHistory, historyValue } from '../../src/tools/history/asset-history.ts';
import { listRecentChanges } from '../../src/tools/history/recent-changes.ts';
import snapshotJson from '../fixtures/agility/meta-snapshot.json' with { type: 'json' };
import {
  FakeAgility,
  type FakeAgilityOptions,
  makeContext,
  measureCost,
  poison,
  probeTool,
} from '../harness/index.ts';
import { rpc } from '../helpers/mcp.ts';

const SNAPSHOT = snapshotJson as unknown as Record<string, unknown>;
const NOW = Date.parse('2026-10-21T12:00:00Z');
const inScope = { Scope: 'Scope:1001', 'Scope.Name': 'Mobile App' };

type Attrs = Record<string, unknown>;
const version = (oid: string, moment: number, at: string | null, attrs: Attrs) => ({
  _type: 'Asset',
  href: `/SyntheticInstance/rest-1.v1/Data/${oid.replace(':', '/')}/${moment}`,
  id: `${oid}:${moment}`,
  Attributes: Object.fromEntries(
    Object.entries({ ChangeDateUTC: at, ...attrs }).map(([name, value]) => [
      name,
      { _type: 'Attribute', name, value },
    ]),
  ),
});

function histories(poisoned = false): Record<string, unknown[]> {
  const p = (n: number, plain: string) => (poisoned ? poison(n) : plain);
  return {
    'Story:1001': [
      version('Story:1001', 5001, '2026-08-01T09:00:00.000Z', {
        Name: p(1, 'Sign-in page'),
        'Status.Name': null,
        'Owners.Name': [],
        Estimate: null,
        'ChangedBy.Name': p(2, 'Ann Example'),
      }),
      version('Story:1001', 5002, '2026-10-05T10:00:00.000Z', {
        Name: p(1, 'Sign-in page'),
        'Status.Name': p(3, 'In Progress'),
        'Owners.Name': [p(4, 'Ann Example')],
        Estimate: 3,
        'ChangedBy.Name': 'Bo Example',
      }),
      // Only a field nobody follows changed.
      version('Story:1001', 5003, '2026-10-10T08:00:00.000Z', {
        Name: p(1, 'Sign-in page'),
        'Status.Name': p(3, 'In Progress'),
        'Owners.Name': [p(4, 'Ann Example')],
        Estimate: 3,
        'ChangedBy.Name': 'Bo Example',
      }),
      version('Story:1001', 5004, '2026-10-20T10:00:00.000Z', {
        Name: p(1, 'Sign-in page'),
        'Status.Name': 'Done',
        'Owners.Name': [p(4, 'Ann Example'), 'Bo Example'],
        Estimate: 5,
        'ChangedBy.Name': 'Bo Example',
      }),
    ],
    // A version of another asset in the same answer must never be used (L-122).
    'Story:1002': [version('Story:1002', 6001, '2026-10-20T10:00:00.000Z', { Name: 'Other' })],
  };
}

function world(): NonNullable<FakeAgilityOptions['assets']> {
  const story = (id: number, changed: string, extra: Attrs = {}) => ({
    _oid: `Story:${id}`,
    AssetType: 'Story',
    Number: `B-0${id}`,
    Name: `Story ${id}`,
    AssetState: 64,
    ...inScope,
    'Status.Name': 'In Progress',
    ChangeDateUTC: changed,
    'ChangedBy.Name': 'Bo Example',
    ...extra,
  });
  const stories = [
    story(1001, '2026-10-20T10:00:00.000Z', { Team: 'Team:5', 'Team.Name': 'Blue' }),
    story(1002, '2026-10-19T10:00:00.000Z'),
    story(1003, '2026-09-01T10:00:00.000Z'),
    {
      ...story(2001, '2026-10-20T11:00:00.000Z'),
      Scope: 'Scope:2000',
      'Scope.Name': 'Outside',
    },
  ];
  const defect = {
    _oid: 'Defect:1101',
    AssetType: 'Defect',
    Number: 'D-01101',
    Name: 'Crash on save',
    AssetState: 64,
    ...inScope,
    ChangeDateUTC: '2026-10-20T12:00:00.000Z',
    'ChangedBy.Name': 'Ann Example',
  };
  return {
    Story: stories,
    Defect: [defect],
    Task: [],
    Test: [],
    Workitem: [...stories, defect],
    Scope: [
      { _oid: 'Scope:1001', Name: 'Mobile App', AssetState: 64, ChildrenMeAndDown: ['Scope:1001'] },
      { _oid: 'Scope:2000', Name: 'Outside', AssetState: 64, ChildrenMeAndDown: ['Scope:2000'] },
    ],
    Team: [{ _oid: 'Team:5', Name: 'Blue', AssetState: 64 }],
  };
}

function setup(options: { poisoned?: boolean } = {}, over: Partial<ToolContext> = {}) {
  const all = histories(options.poisoned);
  const hist: string[] = [];
  const fake = new FakeAgility({
    meta: SNAPSHOT,
    assets: world(),
    override: (req, call) => {
      if (!call.path.startsWith('rest-1.v1/Hist/')) return undefined;
      hist.push(`${call.path}?${new URL(req.url).searchParams.toString()}`);
      const m = /^rest-1\.v1\/Hist\/([A-Za-z]+)\/(\d+)$/.exec(call.path);
      const key = m === null ? '' : `${m[1]}:${m[2]}`;
      const assets = [...(all[key] ?? []), ...(key === 'Story:1001' ? (all['Story:1002'] ?? []) : [])];
      return new Response(
        JSON.stringify({ _type: 'History', pageSize: 2147483647, pageStart: 0, Assets: assets }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  });
  const ctx = (o: Partial<ToolContext> = {}) =>
    makeContext({
      fetch: fake.fetch,
      metadata: new MetadataService(),
      budget: createBudget(100),
      projects: { allowed: ['Scope:1001'], includeChildren: true },
      clock: { now: () => NOW },
      ...over,
      ...o,
    });
  return { fake, ctx, hist };
}

const call = (tool: ToolDefinition, ctx: ToolContext, args: Record<string, unknown> = {}) =>
  rpc(() => buildMcpServer({ tools: [tool], ctx }), 'tools/call', { name: tool.name, arguments: args });
const text = (r: Record<string, unknown>) => (r['content'] as Array<{ text: string }>)[0]?.text ?? '';
const s = (r: Record<string, unknown>) =>
  r['structuredContent'] as Record<string, unknown> & { items: Array<Record<string, unknown>> };

describe('get_asset_history', () => {
  it('shows what changed per field, newest first, diffing against the version before the window', async () => {
    const { ctx, hist } = setup();
    const r = await call(getAssetHistory, ctx(), { asset: 'B-01001', time_range: 'last 30 days' });
    expect(r['isError'], text(r)).toBeUndefined();
    expect(s(r).items.map((i) => [i['version'], i['field'], i['from'], i['to']])).toEqual([
      [4, 'Status.Name', 'In Progress', 'Done'],
      [4, 'Owners.Name', ['Ann Example'], ['Ann Example', 'Bo Example']],
      [4, 'Estimate', 3, 5],
      [2, 'Status.Name', undefined, 'In Progress'],
      [2, 'Owners.Name', [], ['Ann Example']],
      [2, 'Estimate', undefined, 3],
    ]);
    expect(s(r).items[0]).toMatchObject({ changedAt: '2026-10-20T10:00:00.000Z', changedBy: 'Bo Example' });
    expect(s(r)).toMatchObject({
      asset: { assetType: 'Story', oid: 'Story:1001', number: 'B-01001' },
      window: { since: '2026-09-21T12:00:00.000Z', until: '2026-10-21T12:00:00.000Z' },
      versions: { total: 4, inWindow: 3 },
    });
    expect(text(r)).toContain('1 versions in the window changed none of the followed attributes');
    expect(text(r)).toContain('not the activity stream');
    // One Hist request, for the resolved asset, asking only for the followed attributes and the stamp.
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatch(/^rest-1\.v1\/Hist\/Story\/1001\?sel=/);
  });

  it('shows initial values for a first version inside the window and ignores other assets’ versions', async () => {
    const { ctx } = setup();
    const r = await call(getAssetHistory, ctx(), {
      asset: 'Story:1001',
      time_range: '2026-07-31 to 2026-08-02',
      fields: ['Name', 'Estimate'],
    });
    expect(s(r).items.map((i) => [i['field'], 'from' in i, i['to']])).toEqual([
      ['Name', false, 'Sign-in page'],
    ]);
    expect(text(r)).toContain('first version');
    expect(JSON.stringify(r)).not.toContain('Other');
  });

  it('limits the rows and says so; windows are half-open', async () => {
    const { ctx } = setup();
    const r = await call(getAssetHistory, ctx(), { asset: 'B-01001', limit: 2 });
    expect(s(r).items).toHaveLength(2);
    expect(s(r)['truncated']).toBe(true);
    // 2026-10-20 to 2026-10-20 ends the next day and includes version 4 only.
    const day = await call(getAssetHistory, ctx(), {
      asset: 'B-01001',
      time_range: '2026-10-20 to 2026-10-20',
    });
    expect(new Set(s(day).items.map((i) => i['version']))).toEqual(new Set([4]));
    const none = await call(getAssetHistory, ctx(), {
      asset: 'B-01001',
      time_range: '2026-10-05 to 2026-10-04',
    });
    expect(text(none)).toContain('AB_INPUT_INVALID');
  });

  it.each([
    ['a window longer than the workspace allows', { time_range: 'last 400 days' }, /maxTimeRangeDays/],
    ['a window that ends before it starts', { time_range: '2026-10-05 to 2026-10-04' }, /ends before/],
    ['a window nobody can parse', { time_range: 'whenever' }, /not understood/],
    ['more rows than the workspace allows', { limit: 500 }, /maxRows/],
    ['too many fields', { fields: Array.from({ length: 11 }, (_, i) => `Custom_F${i}`) }, /Too big/],
    ['an aggregation', { fields: ['Children.@Count'] }, /plain attributes/],
    ['an unknown attribute', { fields: ['Nope'] }, /AB_/],
  ])('refuses %s before any Agility request', async (_n, args, pattern) => {
    const { ctx, fake } = setup();
    const r = await call(getAssetHistory, ctx(), { asset: 'B-01001', ...args });
    expect(r['isError']).toBe(true);
    expect(text(r)).toMatch(pattern);
    // Window, limit, field count and aggregation checks all run before the resolver's first request.
    expect(fake.requests).toBe((args as { fields?: string[] }).fields?.[0] === 'Nope' ? fake.requests : 0);
  });

  it('refuses a path through a project-bound relation in history', async () => {
    const { ctx, hist } = setup();
    const r = await call(getAssetHistory, ctx(), { asset: 'B-01001', fields: ['Super.Name'] });
    expect(r['isError']).toBe(true);
    expect(text(r)).toMatch(/cannot check against the workspace|AB_/);
    expect(hist).toHaveLength(0);
  });

  it('answers an asset outside the workspace like a missing one, with no history request and no data', async () => {
    const { ctx, hist } = setup();
    const r = await call(getAssetHistory, ctx(), { asset: 'B-02001' });
    expect(r['isError']).toBe(true);
    expect(text(r)).toContain('AB_NOT_FOUND');
    expect(hist).toHaveLength(0);
    expect(JSON.stringify(r)).not.toContain('Outside');
  });

  it('refuses a denied asset type with no history request', async () => {
    const { ctx, hist } = setup({}, { assetTypes: { deny: ['Story'] } });
    const r = await call(getAssetHistory, ctx(), { asset: 'B-01001' });
    expect(r['isError']).toBe(true);
    expect(hist).toHaveLength(0);
  });

  it('reports a history with no versions instead of an empty success', async () => {
    const { ctx } = setup();
    const r = await call(getAssetHistory, ctx(), { asset: 'D-01101' });
    expect(r['isError'], text(r)).toBeUndefined();
    expect(s(r).items).toEqual([]);
    expect(text(r)).toContain('returned no history versions');
  });

  it('turns relation values into OID tokens', () => {
    expect(historyValue({ _type: 'Relation', idref: 'StoryStatus:1' })).toBe('StoryStatus:1');
    expect(historyValue([{ _oid: 'Member:1' }, 'x', null])).toEqual(['Member:1', 'x', null]);
    expect(historyValue({ nested: { deep: 1 } })).toBeNull();
  });
});

describe('list_recent_changes', () => {
  it('lists work items changed in the window across types, newest change first, inside the workspace', async () => {
    const { ctx } = setup();
    const r = await call(listRecentChanges, ctx(), { time_range: 'last 7 days' });
    expect(r['isError'], text(r)).toBeUndefined();
    expect(s(r).items.map((i) => i['number'])).toEqual(['D-01101', 'B-01001', 'B-01002']);
    expect(s(r).items[0]).toMatchObject({ changedAt: '2026-10-20T12:00:00.000Z', changedBy: 'Ann Example' });
    expect(s(r)).toMatchObject({ window: { until: '2026-10-21T12:00:00.000Z' } });
    expect(JSON.stringify(r)).not.toContain('Story 2001');
  });

  it('filters by team and by type, and widens nothing', async () => {
    const { ctx } = setup();
    const team = await call(listRecentChanges, ctx(), { team: 'Blue' });
    expect(s(team).items.map((i) => i['number'])).toEqual(['B-01001']);
    const defects = await call(listRecentChanges, ctx(), {
      asset_type: 'Defect',
      time_range: 'last 90 days',
    });
    expect(s(defects).items.map((i) => i['number'])).toEqual(['D-01101']);
    const outside = await call(listRecentChanges, ctx(), { project: 'Scope:2000' });
    expect(outside['isError']).toBe(true);
  });

  it('hides rows an upstream returns outside the workspace', async () => {
    const fake = new FakeAgility({ meta: SNAPSHOT, assets: world(), filters: 'ignore-filters' });
    const c = makeContext({
      fetch: fake.fetch,
      metadata: new MetadataService(),
      budget: createBudget(100),
      projects: { allowed: ['Scope:1001'], includeChildren: true },
      clock: { now: () => NOW },
    });
    const r = await call(listRecentChanges, c, {});
    expect(JSON.stringify(r)).not.toContain('Story 2001');
    expect(s(r)['hiddenOutsideScope']).toBe(true);
  });

  it('pages without skipping or repeating', async () => {
    const { ctx } = setup();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await call(listRecentChanges, ctx(), {
        limit: 1,
        time_range: 'last 90 days',
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...s(r).items.map((x) => String(x['number'])));
      cursor = s(r)['nextCursor'] as string | undefined;
      if (cursor === undefined) break;
    }
    expect(new Set(seen)).toEqual(new Set(['D-01101', 'B-01001', 'B-01002', 'B-01003']));
    expect(seen).toHaveLength(4);
  });

  it.each([
    ['a window longer than the workspace allows', { time_range: 'last 400 days' }],
    ['a window that ends before it starts', { time_range: '2026-10-05 to 2026-10-04' }],
    ['more rows than the workspace allows', { limit: 500 }],
  ])('refuses %s before any Agility request', async (_n, args) => {
    const { ctx, fake } = setup();
    const r = await call(listRecentChanges, ctx(), args);
    expect(r['isError']).toBe(true);
    expect(fake.requests).toBe(0);
  });

  it('refuses when no requested type is allowed, without a request', async () => {
    const { ctx, fake } = setup({}, { assetTypes: { deny: ['Defect'] } });
    const r = await call(listRecentChanges, ctx(), { asset_type: 'Defect' });
    expect(text(r)).toContain('AB_AUTH_FORBIDDEN');
    expect(fake.requests).toBe(0);
  });
});

describe('untrusted text and costs', () => {
  const cases: Array<[ToolDefinition, Record<string, unknown>]> = [
    [getAssetHistory, { asset: 'B-01001' }],
    [listRecentChanges, {}],
  ];
  const costCases: Array<[ToolDefinition, Record<string, unknown>]> = [
    ...cases,
    [listRecentChanges, { project: 'Mobile App', team: 'Blue', asset_type: 'Story' }],
  ];
  it.each(cases)('%s keeps Agility text inside the envelope', async (tool, args) => {
    const { ctx } = setup({ poisoned: true });
    const { leaks, result } = await probeTool(tool, ctx(), args);
    expect(result['isError'], text(result)).toBeUndefined();
    expect(leaks).toEqual([]);
  });
  it.each(costCases)('%s stays within its declared cost on a cold cache', async (tool, args) => {
    const { ctx, fake } = setup();
    const m = await measureCost(tool, fake, (o) => ctx(o), args);
    expect(m.withinCost, `${m.requests} > ${m.declared}`).toBe(true);
  });
});
