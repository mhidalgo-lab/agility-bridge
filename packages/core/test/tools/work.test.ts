// SPDX-License-Identifier: Apache-2.0
// P1-09 work-item tools on a synthetic world: B-/S-, D-, TK-, AT- items, children, links, statuses from the instance.
import { describe, expect, it } from 'vitest';
import {
  buildMcpServer,
  createBudget,
  MetadataService,
  type ToolContext,
  type ToolDefinition,
} from '../../src/index.ts';
import { getWorkItem } from '../../src/tools/work/get-item.ts';
import { listMyWork } from '../../src/tools/work/my-work.ts';
import { searchWorkItems } from '../../src/tools/work/search.ts';
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
const sprint42 = { Timebox: 'Timebox:42', 'Timebox.Name': 'Sprint 42' };
const ann = { Owners: ['Member:20'], 'Owners.Name': ['Ann Example'] };

function world(prefix = 'B', poisoned = false, tasks = 2): NonNullable<FakeAgilityOptions['assets']> {
  const p = (n: number, plain: string) => (poisoned ? poison(n) : plain);
  const story = {
    _oid: 'Story:1001',
    AssetType: 'Story',
    Number: `${prefix}-01001`,
    Name: p(1, 'Sign-in page'),
    AssetState: 64,
    ...inScope,
    ...sprint42,
    ...ann,
    Status: 'StoryStatus:1',
    'Status.Name': p(2, 'In Progress'),
    Estimate: 3,
    Team: 'Team:5',
    'Team.Name': 'Blue',
    Description: `<p>${p(3, 'As a user I can sign in.')}</p><script>alert(1)</script>`,
    Custom_AcceptanceCriteria: `<ul><li>${p(4, 'Wrong password shows an error')}</li><li>Locked after 5 tries</li></ul>`,
    Super: 'Epic:1401',
    'Super.Number': 'E-01401',
    'Super.Name': p(5, 'Checkout epic'),
    ChangeDateUTC: '2026-10-20T10:00:00.0000000Z',
  };
  const defect = {
    _oid: 'Defect:1101',
    AssetType: 'Defect',
    Number: 'D-01101',
    Name: 'Crash on save',
    AssetState: 64,
    ...inScope,
    ...ann,
    Status: 'StoryStatus:2',
    'Status.Name': 'Done',
  };
  const task = (i: number) => ({
    _oid: `Task:${1200 + i}`,
    AssetType: 'Task',
    Number: `TK-0${1200 + i}`,
    Name: `Task ${i}`,
    AssetState: 64,
    ...inScope,
    ...sprint42,
    ...ann,
    Parent: 'Story:1001',
    'Parent.Number': 'B-01001',
    'Status.Name': 'Open',
    ToDo: 2,
  });
  const test = {
    _oid: 'Test:1301',
    AssetType: 'Test',
    Number: 'AT-01301',
    Name: 'Sign-in test',
    AssetState: 64,
    ...inScope,
    Parent: 'Story:1001',
    'Parent.Number': 'B-01001',
    'Status.Name': 'Passed',
  };
  const tasksRows = Array.from({ length: tasks }, (_, i) => task(i + 1));
  return {
    Story: [story],
    Defect: [defect],
    Task: tasksRows,
    Test: [test],
    Workitem: [story, defect, ...tasksRows, test],
    Issue: [
      {
        _oid: 'Issue:1501',
        AssetType: 'Issue',
        Number: 'I-01501',
        Name: 'Issue',
        AssetState: 64,
        ...inScope,
      },
    ],
    Link: [
      {
        _oid: 'Link:1',
        Name: p(6, 'Spec'),
        URL: 'https://example.com/spec',
        Asset: 'Story:1001',
        'Asset:Workitem.Scope': 'Scope:1001',
        AssetState: 64,
      },
    ],
    Expression: [1, 2, 3].map((i) => ({
      _oid: `Expression:${i}`,
      Mentions: ['Story:1001'],
      'Mentions:Workitem.Scope': ['Scope:1001'],
      AssetState: 64,
    })),
    Scope: [{ _oid: 'Scope:1001', Name: 'Mobile App', AssetState: 64, ChildrenMeAndDown: ['Scope:1001'] }],
    Member: [{ _oid: 'Member:20', Name: p(7, 'Ann Example'), Username: 'ann', IsSelf: true, AssetState: 64 }],
    Team: [{ _oid: 'Team:5', Name: 'Blue', AssetState: 64 }],
    Timebox: [
      {
        _oid: 'Timebox:42',
        Name: 'Sprint 42',
        BeginDate: '2026-10-15T00:00:00Z',
        EndDate: '2026-10-29T00:00:00Z',
        AssetState: 64,
        Schedule: 'Schedule:1',
        'Schedule.ScheduledScopes': ['Scope:1001'],
      },
    ],
    StoryStatus: [
      { _oid: 'StoryStatus:1', Name: 'In Progress', Order: 1, RollupState: 64 },
      { _oid: 'StoryStatus:2', Name: 'Done', Order: 2, RollupState: 128 },
    ],
    TaskStatus: [{ _oid: 'TaskStatus:1', Name: 'Open', Order: 1 }],
    TestStatus: [{ _oid: 'TestStatus:1', Name: 'Passed', Order: 1 }],
  };
}

function setup(
  options: { prefix?: string; poisoned?: boolean; tasks?: number } = {},
  over: Partial<ToolContext> = {},
) {
  const fake = new FakeAgility({
    meta: SNAPSHOT,
    assets: world(options.prefix, options.poisoned, options.tasks),
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
const s = (r: Record<string, unknown>) =>
  r['structuredContent'] as Record<string, unknown> & { items: Array<Record<string, unknown>> };

describe('search_work_items', () => {
  it('searches stories, defects, tasks and tests together, by owner and sprint', async () => {
    const { ctx } = setup();
    const all = await call(searchWorkItems, ctx(), { member: 'me' });
    expect(all['isError'], text(all)).toBeUndefined();
    expect(s(all).items.map((i) => i['number'])).toEqual(['B-01001', 'D-01101', 'TK-01201', 'TK-01202']);
    const sprint = await call(searchWorkItems, ctx(), { sprint: 'current' });
    expect(s(sprint).items.map((i) => i['assetType'])).toEqual(['Story', 'Task', 'Task']);
    expect(s(sprint).items[0]).toMatchObject({
      status: 'In Progress',
      owners: ['Ann Example'],
      sprint: { oid: 'Timebox:42', name: 'Sprint 42' },
      estimate: 3,
    });
  });

  it('filters by status names from the instance and by status category, noting types without one', async () => {
    const { ctx } = setup();
    const done = await call(searchWorkItems, ctx(), { status: ['Done'] });
    expect(s(done).items.map((i) => i['number'])).toEqual(['D-01101']);
    const active = await call(searchWorkItems, ctx(), { status_category: 'in_progress' });
    expect(s(active).items.map((i) => i['number'])).toEqual(['B-01001']);
    expect(text(active)).toContain('Task statuses have no rollup category');
  });

  it('pages across types without skipping or repeating', async () => {
    const { ctx } = setup({ tasks: 3 });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await call(searchWorkItems, ctx(), { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...s(r).items.map((x) => String(x['number'])));
      cursor = s(r)['nextCursor'] as string | undefined;
      if (cursor === undefined) break;
    }
    expect(seen).toEqual(['B-01001', 'D-01101', 'TK-01201', 'TK-01202', 'TK-01203', 'AT-01301']);
    const other = await call(
      searchWorkItems,
      setup().ctx({ projects: { allowed: ['Scope:1002'], includeChildren: false } }),
      { limit: 2, cursor: 'x' },
    );
    expect(text(other)).toMatch(/AB_INPUT_INVALID|AB_AUTH_FORBIDDEN/);
  });

  it('hides denied types', async () => {
    const { ctx } = setup({}, { assetTypes: { deny: ['Defect', 'Task'] } });
    const r = await call(searchWorkItems, ctx(), { member: 'me' });
    expect(s(r).items.map((i) => i['assetType'])).toEqual(['Story']);
    expect(text(await call(searchWorkItems, ctx(), { asset_type: 'Defect' }))).toContain('AB_AUTH_FORBIDDEN');
  });
});

describe('get_work_item', () => {
  it('shows the item with description, acceptance criteria, epic, children, links and comments', async () => {
    const { ctx } = setup();
    const r = await call(getWorkItem, ctx(), { asset: 'B-01001' });
    expect(r['isError'], text(r)).toBeUndefined();
    const out = s(r) as unknown as {
      item: Record<string, unknown>;
      children: Array<{ number: string }>;
      links: Array<{ url: string }>;
      commentCount: number;
    };
    expect(out.item).toMatchObject({
      number: 'B-01001',
      status: 'In Progress',
      description: 'As a user I can sign in.',
      acceptanceCriteria: '- Wrong password shows an error\n- Locked after 5 tries',
      epic: { oid: 'Epic:1401', number: 'E-01401', name: 'Checkout epic' },
    });
    expect(out.children.map((c) => c.number)).toEqual(['TK-01201', 'TK-01202', 'AT-01301']);
    expect(out.links).toEqual([{ oid: 'Link:1', name: 'Spec', url: 'https://example.com/spec' }]);
    expect(out.commentCount).toBe(3);
    expect(text(r)).not.toContain('alert(1)');
    const task = await call(getWorkItem, ctx(), { asset: 'TK-01201' });
    expect((s(task) as unknown as { item: { parent: unknown } }).item.parent).toMatchObject({
      oid: 'Story:1001',
      number: 'B-01001',
    });
  });

  it('marks the result partial when children are capped', async () => {
    const { ctx } = setup({ tasks: 25 });
    const r = await call(getWorkItem, ctx(), { asset: 'B-01001' });
    expect(s(r)).toMatchObject({ partial: true });
    expect(text(r)).toContain('Only the first 20 child tasks');
  });

  it('works with S- story numbers and refuses non-work items', async () => {
    const { ctx } = setup({ prefix: 'S' });
    expect(
      (s(await call(getWorkItem, ctx(), { asset: 'S-01001' })) as unknown as { item: { oid: string } }).item
        .oid,
    ).toBe('Story:1001');
    expect(text(await call(getWorkItem, ctx(), { asset: 'I-01501' }))).toContain('is not a work item');
    expect(text(await call(getWorkItem, ctx(), { asset: 'B-09999' }))).toContain('AB_NOT_FOUND');
  });
});

describe('list_my_work', () => {
  it('lists my open items grouped by sprint and status', async () => {
    const { ctx } = setup();
    const r = await call(listMyWork, ctx());
    const out = s(r) as unknown as {
      items: Array<{ number: string }>;
      groups: Array<{ sprint?: string; status?: string; items: number }>;
      member: { oid: string };
    };
    expect(out.member.oid).toBe('Member:20');
    expect(out.items.map((i) => i.number)).toEqual(['B-01001', 'TK-01201', 'TK-01202', 'D-01101']);
    expect(out.groups).toEqual([
      { sprint: 'Sprint 42', status: 'In Progress', items: 1 },
      { sprint: 'Sprint 42', status: 'Open', items: 2 },
      { status: 'Done', items: 1 },
    ]);
  });
});

describe('untrusted text and costs', () => {
  const cases: Array<[ToolDefinition, Record<string, unknown>]> = [
    [searchWorkItems, { member: 'me' }],
    [getWorkItem, { asset: 'B-01001' }],
    [listMyWork, {}],
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
});
