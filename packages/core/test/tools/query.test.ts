// SPDX-License-Identifier: Apache-2.0
// P1-08 generic tools: every asset type with custom fields, scope rechecks, cursors, global/denied types, the group switch.
import { describe, expect, it } from 'vitest';
import { resolveAsset } from '../../src/identity/resolve.ts';
import {
  buildMcpServer,
  createBudget,
  MetadataService,
  type ToolContext,
  type ToolDefinition,
  ToolRegistry,
} from '../../src/index.ts';
import { listProjects } from '../../src/tools/core/list-projects.ts';
import { CORE_TOOLS } from '../../src/tools/index.ts';
import { getAssets } from '../../src/tools/query/get-assets.ts';
import { queryAssets } from '../../src/tools/query/query-assets.ts';
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
const where = (scope: string) => ({
  Scope: scope,
  'Scope.Name':
    scope === 'Scope:2000' ? 'Outside' : scope === 'Scope:1002' ? 'Mobile App - iOS' : 'Mobile App',
});
const asset = (
  type: string,
  prefix: string,
  id: number,
  scope = 'Scope:1001',
  extra: Record<string, unknown> = {},
) => ({
  _oid: `${type}:${id}`,
  AssetType: type,
  Number: `${prefix}-0${id}`,
  Name: `Synthetic ${type} ${id}`,
  AssetState: 64,
  ...where(scope),
  ...extra,
});

function world(poisoned = false): NonNullable<FakeAgilityOptions['assets']> {
  const p = (n: number, plain: string) => (poisoned ? poison(n) : plain);
  const stories = [
    asset('Story', 'B', 1001, 'Scope:1001', {
      Name: p(1, 'Sign-in page'),
      'Status.Name': p(2, 'In Progress'),
      Estimate: 3,
      Custom_SyntheticNote: `<p>${p(3, 'Needs <b>design</b> review')}</p>`,
    }),
    asset('Story', 'B', 1002, 'Scope:1002', { 'Status.Name': 'Done', Estimate: 5 }),
    asset('Story', 'B', 1003, 'Scope:2000'),
  ];
  const typed = {
    Defect: [asset('Defect', 'D', 1101, 'Scope:1001', { Custom_SyntheticSeverity: p(4, 'High') })],
    Task: [asset('Task', 'TK', 1201)],
    Test: [asset('Test', 'AT', 1301)],
    Epic: [asset('Epic', 'E', 1401)],
    Issue: [asset('Issue', 'I', 1501)],
    Request: [asset('Request', 'R', 1601)],
    RegressionTest: [asset('RegressionTest', 'RT', 1701)],
  };
  return {
    Story: stories,
    ...typed,
    Workitem: [...stories, ...typed.Defect, ...typed.Task, ...typed.Test, ...typed.Epic],
    Scope: [
      {
        _oid: 'Scope:1001',
        Name: 'Mobile App',
        AssetState: 64,
        ChildrenMeAndDown: ['Scope:1001', 'Scope:1002'],
      },
      { _oid: 'Scope:1002', Name: 'Mobile App - iOS', AssetState: 64, ChildrenMeAndDown: ['Scope:1002'] },
      { _oid: 'Scope:2000', Name: 'Outside', AssetState: 64, ChildrenMeAndDown: ['Scope:2000'] },
    ],
    Member: [{ _oid: 'Member:20', Name: p(5, 'Ann Example'), Username: 'ann', AssetState: 64 }],
  };
}

function setup(over: Partial<ToolContext> = {}, poisoned = false, fakeOptions: FakeAgilityOptions = {}) {
  const fake = new FakeAgility({ meta: SNAPSHOT, assets: world(poisoned), ...fakeOptions });
  const ctx = (o: Partial<ToolContext> = {}) =>
    makeContext({
      fetch: fake.fetch,
      metadata: new MetadataService(),
      budget: createBudget(100),
      projects: { allowed: ['Scope:1001'], includeChildren: true },
      ...over,
      ...o,
    });
  return { fake, ctx };
}

const call = (tool: ToolDefinition, ctx: ToolContext, args: Record<string, unknown> = {}) =>
  rpc(() => buildMcpServer({ tools: [tool], ctx }), 'tools/call', { name: tool.name, arguments: args });
const text = (r: Record<string, unknown>) => (r['content'] as Array<{ text: string }>)[0]?.text ?? '';
const items = (r: Record<string, unknown>) =>
  (r['structuredContent'] as { items: Array<Record<string, unknown>> }).items;

describe('query_assets', () => {
  it.each([
    ['Story', 'B-01001'],
    ['Defect', 'D-01101'],
    ['Task', 'TK-01201'],
    ['Test', 'AT-01301'],
    ['Epic', 'E-01401'],
    ['Issue', 'I-01501'],
    ['Request', 'R-01601'],
    ['RegressionTest', 'RT-01701'],
  ])('reads %s with identity on every row', async (assetType, number) => {
    const { ctx } = setup();
    const r = await call(queryAssets, ctx(), { asset_type: assetType, fields: ['Name'] });
    expect(r['isError'], text(r)).toBeUndefined();
    expect(items(r)[0]).toMatchObject({
      number,
      assetType,
      state: 'active',
      project: { oid: 'Scope:1001', name: 'Mobile App' },
      Name: expect.any(String),
    });
  });

  it('returns custom fields, converting rich text', async () => {
    const { ctx } = setup();
    const story = await call(queryAssets, ctx(), {
      asset_type: 'Story',
      fields: ['Name', 'Custom_SyntheticNote'],
      filters: [{ field: 'Estimate', op: 'ge', value: 3 }],
    });
    expect(items(story).map((i) => i['oid'])).toEqual(['Story:1001', 'Story:1002']);
    expect(items(story)[0]?.['Custom_SyntheticNote']).toBe('Needs **design** review');
    const defect = await call(queryAssets, ctx(), {
      asset_type: 'Defect',
      fields: ['Custom_SyntheticSeverity'],
    });
    expect(items(defect)[0]?.['Custom_SyntheticSeverity']).toBe('High');
  });

  it('never returns rows outside the workspace and narrows to one project', async () => {
    const { ctx } = setup();
    const all = await call(queryAssets, ctx(), { asset_type: 'Story', fields: ['Name'] });
    expect(items(all).map((i) => i['oid'])).toEqual(['Story:1001', 'Story:1002']);
    const ios = await call(queryAssets, ctx(), {
      asset_type: 'Story',
      fields: ['Name'],
      project: 'Mobile App - iOS',
    });
    expect(items(ios).map((i) => i['oid'])).toEqual(['Story:1002']);
    const outside = await call(queryAssets, ctx(), {
      asset_type: 'Story',
      fields: ['Name'],
      project: 'Outside',
    });
    expect(text(outside)).toContain('AB_NOT_FOUND');
  });

  it('rechecks rows the upstream should not have returned', async () => {
    const { ctx } = setup({}, false, { filters: 'ignore-filters' });
    const r = await call(queryAssets, ctx(), { asset_type: 'Story', fields: ['Name'] });
    expect(items(r).map((i) => i['oid'])).not.toContain('Story:1003');
    expect(r['structuredContent']).toMatchObject({ hiddenOutsideScope: true });
  });

  it('pages with a cursor bound to tool, workspace and filters, refused before any request otherwise', async () => {
    const { ctx, fake } = setup();
    const first = await call(queryAssets, ctx(), { asset_type: 'Story', fields: ['Name'], limit: 1 });
    const cursor = (first['structuredContent'] as { nextCursor: string }).nextCursor;
    const second = await call(queryAssets, ctx(), {
      asset_type: 'Story',
      fields: ['Name'],
      limit: 1,
      cursor,
    });
    expect(items(second).map((i) => i['oid'])).toEqual(['Story:1002']);
    expect(second['structuredContent']).not.toHaveProperty('nextCursor');
    const projectsCursor = (await call(listProjects, ctx(), { limit: 1 }))['structuredContent'] as {
      nextCursor: string;
    };
    for (const [args, c] of [
      [{ asset_type: 'Story', fields: ['Name', 'Estimate'] }, ctx()],
      [{ asset_type: 'Defect', fields: ['Name'] }, ctx()],
      [
        { asset_type: 'Story', fields: ['Name'] },
        ctx({ projects: { allowed: ['Scope:1002'], includeChildren: true } }),
      ],
    ] as const) {
      const before = fake.requests;
      const r = await call(queryAssets, c, { ...args, limit: 1, cursor });
      expect(text(r)).toContain('AB_INPUT_INVALID');
      expect(fake.requests - before).toBeLessThanOrEqual(2);
    }
    const foreign = await call(queryAssets, ctx(), {
      asset_type: 'Story',
      fields: ['Name'],
      cursor: projectsCursor.nextCursor,
    });
    expect(text(foreign)).toContain('The cursor does not belong');
  });

  it('refuses global types unless the workspace allows them, and denied or unknown types', async () => {
    const { ctx } = setup();
    expect(text(await call(queryAssets, ctx(), { asset_type: 'Member', fields: ['Name'] }))).toContain(
      'AB_AUTH_FORBIDDEN',
    );
    const allowed = await call(queryAssets, ctx({ assetTypes: { allow: ['Member', 'Story'], deny: [] } }), {
      asset_type: 'Member',
      fields: ['Name'],
    });
    expect(items(allowed)).toHaveLength(1);
    expect(text(await call(queryAssets, ctx(), { asset_type: 'Role', fields: ['Name'] }))).toContain(
      'AB_AUTH_FORBIDDEN',
    );
    expect(
      text(await call(queryAssets, ctx({ assetTypes: { deny: ['Story'] } }), { asset_type: 'Story' })),
    ).toContain('AB_AUTH_FORBIDDEN');
    expect(text(await call(queryAssets, ctx(), { asset_type: 'Spaceship' }))).toContain('AB_INPUT_INVALID');
  });

  it('stops at its declared cost on a cold cache and succeeds on the retry', async () => {
    const { ctx } = setup();
    const service = new MetadataService();
    const fields = [
      'Status.Name',
      'Owners.Name',
      'Timebox.Name',
      'Team.Name',
      'Super.Name',
      'Parent.Name',
      'Priority.Name',
      'Scope.Schedule.Name',
      'Custom_SyntheticRisk.Name',
    ];
    const first = await call(queryAssets, ctx({ metadata: service }), { asset_type: 'Story', fields });
    expect(text(first)).toContain('AB_BUDGET_EXHAUSTED');
    const retry = await call(queryAssets, ctx({ metadata: service }), { asset_type: 'Story', fields });
    expect(retry['isError'], text(retry)).toBeUndefined();
  });
});

describe('get_assets', () => {
  it('never lets an upstream that ignores the filter substitute another asset (P2-12)', async () => {
    const { ctx } = setup({}, false, { filters: 'ignore-filters' });
    for (const ref of ['B-01003', 'Story:1003', 'XX-09999']) {
      const r = await call(getAssets, ctx(), { assets: [ref], fields: ['Name'] });
      expect(r['structuredContent'], ref).toMatchObject({ items: [], notFound: [ref] });
    }
    for (const ref of ['B-01003', 'Story:1003']) {
      await expect(resolveAsset(ctx(), ref), ref).rejects.toMatchObject({ code: 'AB_NOT_FOUND' });
    }
  });

  it('gets numbers and OID tokens across types, listing what is not found or not visible', async () => {
    const { ctx } = setup({ assetTypes: { deny: ['Epic'] } });
    const r = await call(getAssets, ctx(), {
      assets: [
        'B-01001',
        'Defect:1101',
        'tk-01201',
        'I-01501',
        'B-01003',
        'B-09999',
        'E-01401',
        'Spaceship:1',
      ],
      fields: ['Name', 'Estimate'],
    });
    expect(
      items(r)
        .map((i) => i['oid'])
        .sort(),
    ).toEqual(['Defect:1101', 'Issue:1501', 'Story:1001', 'Task:1201']);
    expect((r['structuredContent'] as { notFound: string[] }).notFound).toEqual([
      'B-01003',
      'B-09999',
      'E-01401',
      'Spaceship:1',
    ]);
    expect(text(r)).toContain('Task has no attribute path Estimate');
  });

  it('refuses malformed identifiers', async () => {
    const { ctx, fake } = setup();
    expect(text(await call(getAssets, ctx(), { assets: ["B-1'|ID!='"] }))).toContain('AB_INPUT_INVALID');
    expect(fake.requests).toBe(0);
  });
});

describe('the query group switch (AB_GENERIC_QUERY)', () => {
  it('removes both tools from tools/list and tools/call when the workspace has no query group', async () => {
    const registry = new ToolRegistry();
    for (const t of CORE_TOOLS) registry.register(t);
    const without = registry.select({ groups: ['core', 'work'] });
    expect(without.map((t) => t.name)).not.toEqual(expect.arrayContaining(['query_assets']));
    const { ctx } = setup();
    const list = await rpc(() => buildMcpServer({ tools: without, ctx: ctx() }), 'tools/list');
    const names = (list['tools'] as Array<{ name: string }>).map((t) => t.name);
    expect(names).not.toContain('query_assets');
    expect(names).not.toContain('get_assets');
    await expect(
      rpc(() => buildMcpServer({ tools: without, ctx: ctx() }), 'tools/call', {
        name: 'query_assets',
        arguments: { asset_type: 'Story' },
      }),
    ).rejects.toThrow();
  });
});

describe('untrusted text and costs', () => {
  const cases: Array<[ToolDefinition, Record<string, unknown>]> = [
    [queryAssets, { asset_type: 'Story', fields: ['Name', 'Status.Name', 'Custom_SyntheticNote'] }],
    [getAssets, { assets: ['B-01001', 'D-01101'], fields: ['Name', 'Custom_SyntheticSeverity'] }],
  ];
  it.each(cases)('%s keeps Agility text inside the envelope', async (tool, args) => {
    const { ctx } = setup({}, true);
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
