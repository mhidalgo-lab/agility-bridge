// SPDX-License-Identifier: Apache-2.0
// P6-01 portfolio tools on a synthetic world: three portfolio levels, backlog items, a closed and a dead epic, and an
// epic in a neighbouring Agility project.
import { describe, expect, it } from 'vitest';
import {
  buildMcpServer,
  createBudget,
  MetadataService,
  type ToolContext,
  type ToolDefinition,
} from '../../src/index.ts';
import { getPortfolioTree } from '../../src/tools/portfolio/get-tree.ts';
import { listPortfolioItems } from '../../src/tools/portfolio/list-items.ts';
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
const NOW = Date.parse('2026-10-27T12:00:00Z');
const inScope = { Scope: 'Scope:1001', 'Scope.Name': 'Mobile App' };

function world(poisoned = false): NonNullable<FakeAgilityOptions['assets']> {
  const p = (n: number, plain: string) => (poisoned ? poison(n) : plain);
  const epic = (
    id: number,
    number: string,
    name: string,
    category: string,
    extra: Record<string, unknown>,
  ) => ({
    _oid: `Epic:${id}`,
    AssetType: 'Epic',
    Number: number,
    Name: name,
    AssetState: 64,
    ...inScope,
    'Category.Name': category,
    Category: 'EpicCategory:1',
    Status: 'EpicStatus:1',
    'Status.Name': p(10 + id, 'In Progress'),
    ChangeDateUTC: '2026-10-20T10:00:00.0000000Z',
    ...extra,
  });
  const link = (id: number) => ({
    Super: `Epic:${id}`,
    'Super.Number': `E-0000${id}`,
    'Super.Name': `Parent ${id}`,
  });
  const epics = [
    epic(1, 'E-00001', p(1, 'Platform'), 'Initiative', { 'Subs.@Count': 3 }),
    epic(2, 'E-00002', p(2, 'Checkout'), 'Feature', { ...link(1), 'Subs.@Count': 4 }),
    epic(3, 'E-00003', 'Legacy', 'Feature', { ...link(1), AssetState: 128, 'Status.Name': 'Done' }),
    epic(4, 'E-00004', p(4, 'Payments'), 'Feature', { ...link(2), 'Subs.@Count': 2 }),
    epic(5, 'E-00005', 'Neighbour', 'Feature', {
      ...link(1),
      Scope: 'Scope:1002',
      'Scope.Name': 'Other project',
    }),
    epic(6, 'E-00006', 'Removed', 'Feature', { ...link(1), AssetState: 255 }),
  ];
  const item = (
    type: string,
    id: number,
    number: string,
    epicId: number,
    extra: Record<string, unknown>,
  ) => ({
    _oid: `${type}:${id}`,
    AssetType: type,
    Number: number,
    Name: p(30 + id, `${type} ${id}`),
    AssetState: 64,
    ...inScope,
    Super: `Epic:${epicId}`,
    Status: 'StoryStatus:1',
    'Status.Name': 'In Progress',
    ...extra,
  });
  const stories = [
    item('Story', 2001, 'B-02001', 1, { Estimate: 1 }),
    item('Story', 2002, 'B-02002', 2, { Estimate: 5, AssetState: 128 }),
    item('Story', 2003, 'B-02003', 2, { Estimate: 3 }),
    item('Story', 2004, 'B-02004', 2, { Estimate: 100, AssetState: 255 }),
    item('Story', 2005, 'B-02005', 2, { Estimate: 7, Scope: 'Scope:1002' }),
    item('Story', 2006, 'B-02006', 4, { Estimate: 2, Status: 'StoryStatus:2', 'Status.Name': 'Done' }),
  ];
  const defects = [
    item('Defect', 3001, 'D-03001', 4, { Estimate: 1 }),
    item('Defect', 3002, 'D-03002', 2, { AssetState: 128 }),
  ];
  return {
    Epic: epics,
    Story: stories,
    Defect: defects,
    Workitem: [...epics, ...stories, ...defects],
    Scope: [
      { _oid: 'Scope:1001', Name: 'Mobile App', AssetState: 64, ChildrenMeAndDown: ['Scope:1001'] },
      { _oid: 'Scope:1002', Name: 'Other project', AssetState: 64, ChildrenMeAndDown: ['Scope:1002'] },
    ],
    StoryStatus: [
      { _oid: 'StoryStatus:1', Name: 'In Progress', Order: 1, RollupState: 64 },
      { _oid: 'StoryStatus:2', Name: 'Done', Order: 2, RollupState: 128 },
    ],
    EpicStatus: [{ _oid: 'EpicStatus:1', Name: 'In Progress', Order: 1 }],
  };
}

function setup(
  options: { poisoned?: boolean; filters?: 'evaluate' | 'ignore-filters' } = {},
  over: Partial<ToolContext> = {},
) {
  const fake = new FakeAgility({
    meta: SNAPSHOT,
    assets: world(options.poisoned),
    ...(options.filters === undefined ? {} : { filters: options.filters }),
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
  return { fake, ctx };
}

const call = (tool: ToolDefinition, ctx: ToolContext, args: Record<string, unknown> = {}) =>
  rpc(() => buildMcpServer({ tools: [tool], ctx }), 'tools/call', { name: tool.name, arguments: args });
const text = (r: Record<string, unknown>) => (r['content'] as Array<{ text: string }>)[0]?.text ?? '';
type Rows = Array<Record<string, unknown>>;
const list = (r: Record<string, unknown>) =>
  r['structuredContent'] as Record<string, unknown> & { items: Rows };
const tree = (r: Record<string, unknown>) =>
  r['structuredContent'] as Record<string, unknown> & { root: string; nodes: Rows; backlogItems?: Rows };
const byNumber = (nodes: Rows, number: string) => nodes.find((n) => n['number'] === number) as Rows[number];

describe('list_portfolio_items', () => {
  it('lists epics with category, status, parent and child counts, never dead or foreign ones', async () => {
    const { ctx } = setup();
    const r = await call(listPortfolioItems, ctx());
    expect(r['isError'], text(r)).toBeUndefined();
    expect(list(r).items.map((i) => i['number'])).toEqual(['E-00001', 'E-00002', 'E-00004']);
    expect(list(r).items[1]).toMatchObject({
      assetType: 'Epic',
      oid: 'Epic:2',
      state: 'active',
      project: { oid: 'Scope:1001', name: 'Mobile App' },
      category: 'Feature',
      status: 'In Progress',
      parent: { oid: 'Epic:1', number: 'E-00001', name: 'Parent 1' },
      childCount: 4,
    });
    const closed = await call(listPortfolioItems, ctx(), { include_closed: true });
    expect(list(closed).items.map((i) => i['number'])).toEqual(['E-00001', 'E-00002', 'E-00003', 'E-00004']);
  });

  it('filters by category, status, parent and name text', async () => {
    const { ctx } = setup();
    const features = await call(listPortfolioItems, ctx(), { category: ['Feature'] });
    expect(list(features).items.map((i) => i['number'])).toEqual(['E-00002', 'E-00004']);
    const initiatives = await call(listPortfolioItems, ctx(), { category: ['Initiative'] });
    expect(list(initiatives).items.map((i) => i['number'])).toEqual(['E-00001']);
    const children = await call(listPortfolioItems, ctx(), { parent: 'E-00001' });
    expect(list(children).items.map((i) => i['number'])).toEqual(['E-00002']);
    const named = await call(listPortfolioItems, ctx(), { contains: 'pay' });
    expect(list(named).items.map((i) => i['number'])).toEqual(['E-00004']);
    const status = await call(listPortfolioItems, ctx(), { status: ['In Progress'], sort_by: 'name' });
    expect(list(status).items.map((i) => i['number'])).toEqual(['E-00002', 'E-00004', 'E-00001']);
  });

  it('pages without skipping and refuses a cursor from other filters', async () => {
    const { ctx } = setup();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 4; i++) {
      const r = await call(listPortfolioItems, ctx(), {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...list(r).items.map((x) => String(x['number'])));
      cursor = list(r)['nextCursor'] as string | undefined;
      if (cursor === undefined) break;
    }
    expect(seen).toEqual(['E-00001', 'E-00002', 'E-00004']);
    const first = await call(listPortfolioItems, ctx(), { limit: 1 });
    const other = await call(listPortfolioItems, ctx(), {
      limit: 1,
      category: ['Feature'],
      cursor: list(first)['nextCursor'],
    });
    expect(text(other)).toContain('AB_INPUT_INVALID');
  });

  it('refuses a parent that is not an epic', async () => {
    const { ctx } = setup();
    expect(text(await call(listPortfolioItems, ctx(), { parent: 'Story:2001' }))).toContain(
      'not a portfolio item',
    );
  });

  it('makes no request when Epic is not allowed in the workspace', async () => {
    const { ctx, fake } = setup({}, { assetTypes: { deny: ['Epic'] } });
    const r = await call(listPortfolioItems, ctx());
    expect(text(r)).toContain('AB_AUTH_FORBIDDEN');
    expect(r['structuredContent']).toBeUndefined();
    expect(fake.requests).toBe(0);
  });

  it('drops rows from other Agility projects when the upstream ignores the filters', async () => {
    const { ctx } = setup({ filters: 'ignore-filters' });
    const r = await call(listPortfolioItems, ctx());
    expect(list(r).items.every((i) => (i['project'] as { oid: string }).oid === 'Scope:1001')).toBe(true);
    expect(list(r)['hiddenOutsideScope']).toBe(true);
    expect(text(r)).not.toContain('Neighbour');
  });
});

describe('get_portfolio_tree', () => {
  it('rolls up three levels, excluding dead assets and counting closed items as done', async () => {
    const { ctx } = setup();
    const r = await call(getPortfolioTree, ctx(), { asset: 'E-00001' });
    expect(r['isError'], text(r)).toBeUndefined();
    const out = tree(r);
    expect(out.root).toBe('Epic:1');
    expect(out.nodes.map((n) => [n['number'], n['depth']])).toEqual([
      ['E-00001', 0],
      ['E-00002', 1],
      ['E-00004', 2],
      ['E-00003', 1],
    ]);
    expect(byNumber(out.nodes, 'E-00004')).toMatchObject({
      itemCount: 2,
      doneItemCount: 1,
      openDefectCount: 1,
      estimate: 3,
      doneEstimate: 2,
      donePercent: 66.7,
      donePercentBasis: 'estimate',
    });
    expect(byNumber(out.nodes, 'E-00002')).toMatchObject({
      itemCount: 5,
      doneItemCount: 3,
      openDefectCount: 1,
      estimate: 11,
      doneEstimate: 7,
      donePercent: 63.6,
    });
    expect(byNumber(out.nodes, 'E-00001')).toMatchObject({
      itemCount: 6,
      doneItemCount: 3,
      openDefectCount: 1,
      estimate: 12,
      donePercent: 58.3,
    });
    expect(byNumber(out.nodes, 'E-00004')).toMatchObject({ parent: { oid: 'Epic:2' }, state: 'active' });
    expect(byNumber(out.nodes, 'E-00003')).toMatchObject({ itemCount: 0, depth: 1, state: 'closed' });
    expect(byNumber(out.nodes, 'E-00003')?.['donePercent']).toBeUndefined();
    // Nothing is cut, so nothing is partial or incomplete; the foreign epic and the dead one never appear.
    expect(out['partial']).toBeUndefined();
    expect(out.nodes.some((n) => n['incomplete'] === true)).toBe(false);
    expect(out.nodes.map((n) => n['number'])).not.toContain('E-00005');
    expect(out.nodes.map((n) => n['number'])).not.toContain('E-00006');
  });

  it('lists the backlog items on request', async () => {
    const { ctx } = setup();
    const r = await call(getPortfolioTree, ctx(), { asset: 'Epic:2', include_items: true });
    expect(tree(r).backlogItems?.map((i) => i['number'])).toEqual([
      'B-02002',
      'B-02003',
      'B-02006',
      'D-03001',
      'D-03002',
    ]);
    expect(tree(r).backlogItems?.[0]).toMatchObject({
      assetType: 'Story',
      epic: 'Epic:2',
      done: true,
      estimate: 5,
    });
  });

  it('is partial when the depth cuts the tree, and marks the roll-ups above the cut incomplete', async () => {
    const { ctx } = setup();
    const r = await call(getPortfolioTree, ctx(), { asset: 'E-00001', depth: 1 });
    const out = tree(r);
    expect(out['partial']).toBe(true);
    expect(text(r)).toContain('Epics exist below level 1');
    expect(out.nodes.map((n) => n['number'])).toEqual(['E-00001', 'E-00002', 'E-00003']);
    expect(byNumber(out.nodes, 'E-00002')).toMatchObject({ incomplete: true, itemCount: 3 });
    expect(byNumber(out.nodes, 'E-00001')).toMatchObject({ incomplete: true });
    expect(byNumber(out.nodes, 'E-00003')?.['incomplete']).toBeUndefined();
  });

  it('is partial when a level is cut by max_items', async () => {
    const { ctx } = setup();
    const r = await call(getPortfolioTree, ctx(), { asset: 'E-00001', max_items: 1 });
    expect(tree(r)['partial']).toBe(true);
    expect(text(r)).toContain('Level 1 has more than 1 epics');
    expect(tree(r).nodes.every((n) => n['incomplete'] === true)).toBe(true);
  });

  it('leaves out a backlog type the workspace does not allow and says so', async () => {
    const { ctx } = setup({}, { assetTypes: { deny: ['Story'] } });
    const r = await call(getPortfolioTree, ctx(), { asset: 'E-00001' });
    const out = tree(r);
    expect(out['partial']).toBe(true);
    expect(text(r)).toContain('Story are not allowed');
    expect(byNumber(out.nodes, 'E-00004')).toMatchObject({
      itemCount: 1,
      openDefectCount: 1,
      incomplete: true,
    });
  });

  it('is partial when the request budget runs out part way', async () => {
    const { ctx } = setup();
    // Enough for the metadata, the epic and the first level, not for the rest.
    for (const budget of [12, 13, 14, 15, 16, 17]) {
      const r = await call(getPortfolioTree, ctx({ budget: createBudget(budget) }), { asset: 'E-00001' });
      if (r['isError'] === true) continue;
      if (tree(r)['partial'] === true) {
        expect(tree(r).nodes.every((n) => n['incomplete'] === true)).toBe(true);
        expect(text(r)).toContain('budget');
        return;
      }
    }
    throw new Error('no budget in the range produced a partial tree');
  });

  it('refuses assets that are not epics, and epics outside the workspace, with no data', async () => {
    const { ctx } = setup();
    const story = await call(getPortfolioTree, ctx(), { asset: 'Story:2001' });
    expect(text(story)).toContain('is not a portfolio item');
    expect(story['structuredContent']).toBeUndefined();
    const foreign = await call(getPortfolioTree, ctx(), { asset: 'E-00005' });
    expect(text(foreign)).toContain('AB_NOT_FOUND');
    expect(foreign['structuredContent']).toBeUndefined();
    expect(text(foreign)).not.toContain('Neighbour');
  });

  it('makes no request when Epic is not allowed in the workspace', async () => {
    const { ctx, fake } = setup({}, { assetTypes: { deny: ['Epic'] } });
    const r = await call(getPortfolioTree, ctx(), { asset: 'E-00001' });
    expect(text(r)).toContain('AB_AUTH_FORBIDDEN');
    expect(fake.requests).toBe(0);
  });

  it('does not trust an upstream that ignores filters: no substituted epic, no foreign rows', async () => {
    const { ctx } = setup({ filters: 'ignore-filters' });
    // The first epic the upstream returns for the ID filter is not the one asked for.
    const other = await call(getPortfolioTree, ctx(), { asset: 'Epic:4' });
    expect(other['isError']).toBe(true);
    expect(text(other)).not.toContain('Payments');
    // Asking for the first epic works, and nothing from the neighbouring project or from other parents shows.
    const r = await call(getPortfolioTree, ctx(), { asset: 'Epic:1' });
    if (r['isError'] !== true) {
      const out = tree(r);
      expect(out.nodes.map((n) => n['oid'])).not.toContain('Epic:5');
      expect(out['hiddenOutsideScope']).toBe(true);
      expect(text(r)).not.toContain('Neighbour');
    }
  });
});

describe('untrusted text and costs', () => {
  const cases: Array<[ToolDefinition, Record<string, unknown>]> = [
    [listPortfolioItems, {}],
    [getPortfolioTree, { asset: 'E-00001', include_items: true }],
  ];
  it.each(cases)('%s keeps Agility text inside the envelope', async (tool, args) => {
    const { ctx } = setup({ poisoned: true });
    const { leaks, result } = await probeTool(tool, ctx(), args);
    expect(result['isError'], text(result)).toBeUndefined();
    expect(leaks).toEqual([]);
  });
  it.each(cases)('%s stays within its declared cost on a cold cache', async (tool, args) => {
    const { ctx, fake } = setup();
    const m = await measureCost(tool, fake, (o) => ctx(o), args);
    expect(m.withinCost, `${m.requests} > ${m.declared}`).toBe(true);
  });
  it('the deepest tree call (four levels, every item page) stays within its declared cost', async () => {
    const base = world();
    const epic = (id: number, parent: number) => ({
      ...(base['Epic'] as Rows)[0],
      _oid: `Epic:${id}`,
      Number: `E-0${id}`,
      Super: `Epic:${parent}`,
    });
    const deeper = [epic(7, 4), epic(8, 7), epic(9, 8)];
    const many = Array.from({ length: 250 }, (_, i) => ({
      ...(base['Story'] as Rows)[0],
      _oid: `Story:${5000 + i}`,
      Number: `B-0${5000 + i}`,
      Super: 'Epic:1',
    }));
    const assets = {
      ...base,
      Epic: [...(base['Epic'] as Rows), ...deeper],
      Story: [...(base['Story'] as Rows), ...many],
    };
    const fake = new FakeAgility({ meta: SNAPSHOT, assets });
    const ctx = (o: Partial<ToolContext> = {}) =>
      makeContext({
        fetch: fake.fetch,
        metadata: new MetadataService(),
        projects: { allowed: ['Scope:1001'], includeChildren: true },
        ...o,
      });
    const m = await measureCost(getPortfolioTree, fake, (o) => ctx(o), {
      asset: 'E-00001',
      depth: 4,
      include_items: true,
    });
    expect(m.withinCost, `${m.requests} > ${m.declared}`).toBe(true);
    // The deepest call really is deep: it is within two requests of the declared cost.
    expect(m.requests).toBeGreaterThanOrEqual(m.declared - 2);
  });
  it('the most expensive list call (project and parent filters) stays within its declared cost', async () => {
    const { ctx, fake } = setup();
    const m = await measureCost(listPortfolioItems, fake, (o) => ctx(o), {
      project: 'Mobile App',
      parent: 'E-00001',
      category: ['Feature'],
      status: ['In Progress'],
      contains: 'a',
    });
    expect(m.withinCost, `${m.requests} > ${m.declared}`).toBe(true);
  });
});
