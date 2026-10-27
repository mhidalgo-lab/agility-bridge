// SPDX-License-Identifier: Apache-2.0
// P1-07 discovery tools: contract, negative authorization, leak probes and worst-case costs.
import { describe, expect, it } from 'vitest';
import {
  buildMcpServer,
  createBudget,
  MetadataService,
  type ToolContext,
  type ToolDefinition,
} from '../../src/index.ts';
import { describeAssetType, listAssetTypes } from '../../src/tools/core/asset-types.ts';
import { listProjects } from '../../src/tools/core/list-projects.ts';
import { whoami } from '../../src/tools/core/whoami.ts';
import { CORE_TOOLS } from '../../src/tools/index.ts';
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

function world(poisoned = false): NonNullable<FakeAgilityOptions['assets']> {
  const name = (n: number, plain: string) => (poisoned ? poison(n) : plain);
  return {
    Scope: [
      {
        _oid: 'Scope:1001',
        Name: name(1, 'Mobile App'),
        AssetState: 64,
        ChildrenMeAndDown: ['Scope:1001', 'Scope:1002'],
        Schedule: { _oid: 'Schedule:1' },
        'Schedule.Name': name(2, 'Two-week'),
      },
      {
        _oid: 'Scope:1002',
        Name: name(3, 'Mobile App - iOS'),
        AssetState: 64,
        ChildrenMeAndDown: ['Scope:1002'],
        Parent: { _oid: 'Scope:1001' },
        'Parent.Name': name(4, 'Mobile App'),
      },
      {
        _oid: 'Scope:1003',
        Name: name(5, 'Mobile App - Android (closed)'),
        AssetState: 128,
        ChildrenMeAndDown: ['Scope:1003'],
      },
      { _oid: 'Scope:2000', Name: 'Outside project', AssetState: 64, ChildrenMeAndDown: ['Scope:2000'] },
    ],
    Member: [
      { _oid: 'Member:20', Name: name(6, 'Ann Example'), Username: 'ann', IsSelf: true, AssetState: 64 },
    ],
    Story: [{ _oid: 'Story:1', Number: 'B-00001', AssetState: 64, Scope: 'Scope:1001' }],
    Issue: [{ _oid: 'Issue:1', Number: 'I-00001', AssetState: 64, Scope: 'Scope:1001' }],
    StoryStatus: [
      { _oid: 'StoryStatus:1', Name: name(7, 'In Progress'), Order: 1, Inactive: false, RollupState: 64 },
      { _oid: 'StoryStatus:2', Name: name(8, 'Done'), Order: 2, Inactive: false, RollupState: 128 },
    ],
  };
}

function setup(over: Partial<ToolContext> = {}, poisoned = false) {
  const fake = new FakeAgility({ meta: SNAPSHOT, assets: world(poisoned) });
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

const call = async (tool: ToolDefinition, ctx: ToolContext, args: Record<string, unknown> = {}) =>
  rpc(() => buildMcpServer({ tools: [tool], ctx }), 'tools/call', { name: tool.name, arguments: args });
const text = (r: Record<string, unknown>) => (r['content'] as Array<{ text: string }>)[0]?.text ?? '';

describe('whoami', () => {
  it('shows the member, instance version, workspace, limits by unit and write availability', async () => {
    const { ctx } = setup();
    const r = await call(whoami, ctx());
    expect(r['isError']).toBeUndefined();
    expect(r['structuredContent']).toMatchObject({
      member: { oid: 'Member:20', name: 'Ann Example' },
      instance: { id: 'env', version: '26.0.3.2' },
      workspace: { id: 'default', groups: expect.arrayContaining(['core']) },
      projects: { allowed: ['Scope:1001'], includeChildProjects: true },
      limits: { maxRows: 100, maxResponseBytes: 524288, requestTimeoutMs: 20000 },
      budget: { requestsPerCall: 100 },
      writes: { enabled: false, approval: 'unavailable' },
    });
    expect(text(r)).toContain('do not expire');
    // Usernames are often email addresses: shown only when the workspace enables member emails (review M5).
    expect(JSON.stringify(r['structuredContent'])).not.toContain('"username"');
  });
});

describe('list_projects', () => {
  it('lists the allowed projects and their sub-projects, never others, sorted by name', async () => {
    const { ctx } = setup();
    const r = await call(listProjects, ctx());
    const items = (r['structuredContent'] as { items: Array<{ oid: string; state: string }> }).items;
    expect(items.map((i) => i.oid)).toEqual(['Scope:1001', 'Scope:1002']);
    expect(items[1]).toMatchObject({ parent: { oid: 'Scope:1001', name: 'Mobile App' } });
    const closed = await call(listProjects, ctx(), { include_closed: true });
    expect((closed['structuredContent'] as { items: unknown[] }).items).toHaveLength(2);
    expect(text(r)).not.toContain('Outside project');
  });

  it('pages with a bound cursor and refuses a cursor from other arguments before any request', async () => {
    const { ctx, fake } = setup();
    const first = await call(listProjects, ctx(), { limit: 1 });
    const cursor = (first['structuredContent'] as { nextCursor?: string }).nextCursor;
    expect(cursor).toBeTypeOf('string');
    const second = await call(listProjects, ctx(), { limit: 1, cursor });
    expect(
      (second['structuredContent'] as { items: Array<{ oid: string }>; nextCursor?: string }).items[0]?.oid,
    ).toBe('Scope:1002');
    const before = fake.requests;
    const wrong = await call(listProjects, ctx(), { limit: 1, cursor, contains: 'iOS' });
    expect(wrong['isError']).toBe(true);
    expect(text(wrong)).toContain('AB_INPUT_INVALID');
    expect(fake.requests).toBe(before);
  });

  it('filters by name with contains', async () => {
    const { ctx } = setup();
    const r = await call(listProjects, ctx(), { contains: 'iOS' });
    expect((r['structuredContent'] as { items: Array<{ oid: string }> }).items.map((i) => i.oid)).toEqual([
      'Scope:1002',
    ]);
  });
});

describe('list_asset_types and describe_asset_type', () => {
  it('lists readable types with base, prefix and scope strategy, hiding denied ones', async () => {
    const { ctx } = setup();
    const r = await call(listAssetTypes, ctx({ assetTypes: { deny: ['Defect'] } }));
    const items = (
      r['structuredContent'] as {
        items: Array<{ assetType: string; scopeStrategy: string; prefix?: string }>;
      }
    ).items;
    const byName = Object.fromEntries(items.map((i) => [i.assetType, i]));
    expect(byName['Defect']).toBeUndefined();
    expect(byName['Story']).toMatchObject({ base: 'PrimaryWorkitem', prefix: 'B-', scopeStrategy: 'direct' });
    expect(byName['Attachment']).toMatchObject({ scopeStrategy: 'derived' });
    expect(byName['Member']).toMatchObject({ scopeStrategy: 'global' });
    expect(byName['Timebox']).toMatchObject({ scopeStrategy: 'workspace_bounded' });
  });

  it('honours an allow list', async () => {
    const { ctx } = setup();
    const r = await call(listAssetTypes, ctx({ assetTypes: { allow: ['Story', 'Task'], deny: [] } }));
    expect(
      (r['structuredContent'] as { items: Array<{ assetType: string }> }).items.map((i) => i.assetType),
    ).toEqual(['Story', 'Task']);
  });

  it('describes a type: attributes (custom included), operations, statuses and tiers', async () => {
    const { ctx } = setup();
    const r = await call(describeAssetType, ctx(), { asset_type: 'Story' });
    const s = r['structuredContent'] as {
      attributes: Array<{ name: string; custom: boolean }>;
      operations: string[];
      statuses: Array<{ name: string }>;
      tiers: { minimal: string[] };
    };
    expect(s.attributes.find((a) => a.name === 'Custom_SyntheticNote')).toMatchObject({ custom: true });
    expect(s.operations).toContain('QuickClose');
    expect(s.statuses.map((x) => x.name)).toEqual(['In Progress', 'Done']);
    expect(s.tiers.minimal).toContain('Number');
    const filtered = await call(describeAssetType, ctx(), { asset_type: 'Story', contains: 'estimate' });
    expect(
      (filtered['structuredContent'] as { attributes: Array<{ name: string }> }).attributes.map(
        (a) => a.name,
      ),
    ).toEqual(['DetailEstimate', 'Estimate']);
  });

  it('refuses a denied type before any request, and types agility-bridge never reads', async () => {
    const { ctx, fake } = setup();
    const denied = await call(describeAssetType, ctx({ assetTypes: { deny: ['Story'] } }), {
      asset_type: 'Story',
    });
    expect(text(denied)).toContain('AB_AUTH_FORBIDDEN');
    expect(fake.requests).toBe(0);
    const role = await call(describeAssetType, ctx(), { asset_type: 'Role' });
    expect(text(role)).toContain('AB_AUTH_FORBIDDEN');
    const unknown = await call(describeAssetType, ctx(), { asset_type: 'Spaceship' });
    expect(text(unknown)).toContain('AB_INPUT_INVALID');
  });
});

describe('untrusted text and costs', () => {
  const cases: Array<[ToolDefinition, Record<string, unknown>]> = [
    [whoami, {}],
    [listProjects, {}],
    [listAssetTypes, {}],
    [describeAssetType, { asset_type: 'Story' }],
  ];

  it.each(cases)('%s keeps every Agility string inside the envelope', async (tool, args) => {
    const { ctx } = setup({}, true);
    const { leaks, result } = await probeTool(tool, ctx(), args);
    expect(result['isError'], text(result)).toBeUndefined();
    expect(leaks).toEqual([]);
  });

  it.each(cases)('%s stays within its declared cost on a cold cache', async (tool, args) => {
    const { ctx, fake } = setup();
    const m = await measureCost(tool, fake, (o) => ctx(o), args);
    expect(m.requests, `${m.tool}: ${m.requests} > ${m.declared}`).toBeLessThanOrEqual(m.declared);
  });
});

describe('whoami composite warnings (P6-11)', () => {
  const asServer = (tools: ToolDefinition[], ctx: ToolContext) =>
    rpc(() => buildMcpServer({ tools, ctx }), 'tools/call', { name: 'whoami', arguments: {} });
  const by = (n: string) => CORE_TOOLS.find((t) => t.name === n) as ToolDefinition;

  it('names a granted composite whose sibling tools are not granted, in the note and the structured result', async () => {
    const { ctx } = setup();
    const r = await asServer([whoami, by('sprint_health')], ctx());
    expect(r['isError'], text(r)).toBeUndefined();
    const warnings = (r['structuredContent'] as { warnings?: Array<{ tool: string; missing: string[] }> })
      .warnings;
    expect(warnings?.map((w) => [w.tool, w.missing])).toEqual([
      ['sprint_health', ['get_sprint', 'search_work_items']],
    ]);
    expect(text(r)).toContain('sprint_health is granted without get_sprint, search_work_items');
  });

  it('says nothing when the siblings are granted or no composite is', async () => {
    const { ctx } = setup();
    for (const tools of [
      [whoami],
      [whoami, by('sprint_health'), by('get_sprint'), by('search_work_items')],
    ]) {
      const r = await asServer(tools, ctx());
      expect(r['structuredContent']).not.toHaveProperty('warnings');
      expect(text(r)).not.toContain('is granted without');
    }
  });
});
