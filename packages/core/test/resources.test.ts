// SPDX-License-Identifier: Apache-2.0
// P6-09 resources: every listed resource is readable, absent when its tools are not allowed, refused without an upstream
// call when the workspace denies the type, enveloped on every path, observed like a tool call (L-153, L-038, L-121).
import { describe, expect, it } from 'vitest';
import {
  assertManifest,
  availableEntries,
  BACKLOG_ITEM_QUALITY_RUBRIC,
  buildMcpServer,
  CORE_TOOLS,
  createBudget,
  MetadataService,
  RESOURCE_MANIFEST,
  type ResourceDefinition,
  type ToolCallEvent,
  type ToolContext,
  type ToolDefinition,
} from '../src/index.ts';
import snapshotJson from './fixtures/agility/meta-snapshot.json' with { type: 'json' };
import { FakeAgility, makeContext, poison } from './harness/index.ts';
import { findLeaks } from './harness/probe.ts';
import { rpc } from './helpers/mcp.ts';

const SNAPSHOT = snapshotJson as unknown as Record<string, unknown>;
const tool = (name: string): ToolDefinition => {
  const t = CORE_TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
};
const URI = {
  filters: 'agility-bridge://reference/filters',
  types: 'agility-bridge://instance/asset-types',
  story: 'agility-bridge://instance/asset-types/Story',
  projects: 'agility-bridge://workspace/projects',
  rubric: 'agility-bridge://rubrics/backlog-item-quality',
};

function world(poisoned: boolean) {
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
      { _oid: 'Scope:2000', Name: 'Outside project', AssetState: 64, ChildrenMeAndDown: ['Scope:2000'] },
    ],
    Member: [{ _oid: 'Member:20', Name: 'Ann Example', Username: 'ann', IsSelf: true, AssetState: 64 }],
    Story: [{ _oid: 'Story:1', Number: 'B-00001', AssetState: 64, Scope: 'Scope:1001' }],
    StoryStatus: [
      { _oid: 'StoryStatus:1', Name: name(7, 'In Progress'), Order: 1, Inactive: false, RollupState: 64 },
      { _oid: 'StoryStatus:2', Name: name(8, 'Done'), Order: 2, Inactive: false, RollupState: 128 },
    ],
  };
}

function setup(poisoned = false) {
  const fake = new FakeAgility({ meta: SNAPSHOT, assets: world(poisoned) });
  const events: ToolCallEvent[] = [];
  const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
    makeContext({
      fetch: fake.fetch,
      metadata: new MetadataService(),
      budget: createBudget(100),
      projects: { allowed: ['Scope:1001'], includeChildren: true },
      ...over,
    });
  const build =
    (tools: readonly ToolDefinition[], over: Partial<ToolContext> = {}) =>
    () =>
      buildMcpServer({ tools, ctx: () => ctx(over), onToolCall: (e) => events.push(e) });
  return { fake, events, build };
}

type Build = () => ReturnType<typeof buildMcpServer>;
/** A server with no resource does not advertise the capability, so `resources/list` is "method not found". */
const list = async (build: Build) => {
  try {
    return ((await rpc(build, 'resources/list')) as { resources: Array<{ uri: string; name: string }> })
      .resources;
  } catch (error) {
    if (/Method not found/.test(String(error))) return [];
    throw error;
  }
};
const read = async (build: Build, uri: string) =>
  (await rpc(build, 'resources/read', { uri })) as {
    contents: Array<{ uri: string; text: string; mimeType: string }>;
  };

describe('resources from the manifest', () => {
  it('the manifest is well formed and every entry uses real tools', () => {
    assertManifest(RESOURCE_MANIFEST);
    for (const e of RESOURCE_MANIFEST) for (const t of e.uses) expect(tool(t).name).toBe(t);
  });

  it('lists every catalogue resource, one URI per readable asset type, and reads every one (L-153)', async () => {
    const { build: buildAll } = setup();
    // The metadata snapshot has no status list for Request, so a listed Request would not be readable: the fixture's
    // allow list keeps to the types it can describe (L-288).
    const over = {
      assetTypes: {
        allow: ['Story', 'Defect', 'Task', 'Test', 'Epic', 'Scope', 'Timebox', 'Member', 'Team'],
        deny: [],
      },
    };
    const build = (tools: readonly ToolDefinition[]) => buildAll(tools, over);
    const listed = await list(build(CORE_TOOLS));
    const uris = listed.map((r) => r.uri);
    expect(uris).toEqual(
      expect.arrayContaining([URI.filters, URI.types, URI.projects, URI.rubric, URI.story]),
    );
    expect(uris.filter((u) => u.startsWith(`${URI.types}/`)).length).toBeGreaterThan(3);
    const failed: string[] = [];
    for (const u of uris) {
      try {
        const r = await read(build(CORE_TOOLS), u);
        expect(r.contents[0]?.uri).toBe(u);
        expect(r.contents[0]?.text.length).toBeGreaterThan(20);
      } catch (error) {
        failed.push(`${u}: ${String(error).slice(0, 160)}`);
      }
    }
    expect(failed).toEqual([]);
    const templates = (await rpc(build(CORE_TOOLS), 'resources/templates/list')) as {
      resourceTemplates: Array<{ uriTemplate: string }>;
    };
    expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toContain(`${URI.types}/{asset_type}`);
  });

  it('serves what the tools serve: allowed projects as a tree, a type with statuses, vocabulary, rubric', async () => {
    const { build } = setup();
    const projects = (await read(build(CORE_TOOLS), URI.projects)).contents[0]?.text ?? '';
    expect(projects).toContain('Mobile App');
    expect(projects).toContain('iOS');
    expect(projects).not.toContain('Outside project');
    const story = (await read(build(CORE_TOOLS), URI.story)).contents[0]?.text ?? '';
    expect(story).toContain('In Progress');
    expect(story).toContain('QuickClose');
    const filters = (await read(build(CORE_TOOLS), URI.filters)).contents[0];
    expect(filters?.mimeType).toBe('text/markdown');
    for (const op of ['eq', 'contains', 'is_not_set']) expect(filters?.text).toContain(`\`${op}\``);
    const rubric = (await read(build(CORE_TOOLS), URI.rubric)).contents[0];
    expect(rubric?.mimeType).toBe('application/json');
    expect(JSON.parse(rubric?.text ?? '{}')).toEqual(JSON.parse(JSON.stringify(BACKLOG_ITEM_QUALITY_RUBRIC)));
    expect(BACKLOG_ITEM_QUALITY_RUBRIC.criteria.reduce((n, c) => n + c.weight, 0)).toBe(100);
  });
});

describe('availability follows the allowed tools', () => {
  it('lists nothing without the tools a resource is served through; reading is refused with no upstream call', async () => {
    const { build, fake } = setup();
    expect(await list(build([tool('whoami')]))).toEqual([]);
    for (const u of Object.values(URI)) {
      await expect(read(build([tool('whoami')]), u)).rejects.toThrow();
    }
    expect(fake.requests).toBe(0);
  });

  it('offers exactly the resources whose tools are allowed', async () => {
    const { build } = setup();
    expect((await list(build([tool('list_projects')]))).map((r) => r.uri)).toEqual([URI.projects]);
    // The per-type template lists types through list_asset_types, so it needs both tools.
    expect(await list(build([tool('describe_asset_type')]))).toEqual([]);
    await expect(read(build([tool('describe_asset_type')]), URI.story)).rejects.toThrow();
    const noQuery = (await list(build(CORE_TOOLS.filter((t) => t.name !== 'query_assets')))).map(
      (r) => r.uri,
    );
    expect(noQuery).not.toContain(URI.filters);
    expect(noQuery).toContain(URI.types);
  });

  it('availableEntries is the one rule', () => {
    expect(availableEntries(RESOURCE_MANIFEST, ['list_projects']).map((e) => e.id)).toEqual([
      'workspace_projects',
    ]);
  });
});

describe('negative authorization', () => {
  it('a denied asset type is neither listed nor readable, and nothing reaches Agility for the read', async () => {
    const { build, fake } = setup();
    const over = { assetTypes: { deny: ['Story'] } };
    expect((await list(build(CORE_TOOLS, over))).map((r) => r.uri)).not.toContain(URI.story);
    const before = fake.requests;
    await expect(read(build(CORE_TOOLS, over), URI.story)).rejects.toThrow(/AB_AUTH_FORBIDDEN/);
    expect(fake.requests).toBe(before);
  });

  it('a type the workspace never reads, an unknown type and a malformed address are refused', async () => {
    const { build } = setup();
    await expect(read(build(CORE_TOOLS), `${URI.types}/Role`)).rejects.toThrow(/AB_AUTH_FORBIDDEN/);
    await expect(read(build(CORE_TOOLS), `${URI.types}/Spaceship`)).rejects.toThrow(/AB_INPUT_INVALID/);
    await expect(read(build(CORE_TOOLS), `${URI.types}/${'x'.repeat(80)}`)).rejects.toThrow();
  });

  it('a read spends from the request budget like the tool call it stands for', async () => {
    const { build } = setup();
    await expect(read(build(CORE_TOOLS, { budget: createBudget(1) }), URI.story)).rejects.toThrow(
      /AB_BUDGET_EXHAUSTED/,
    );
  });
});

describe('untrusted data', () => {
  it('puts every instance string of every resource inside the envelope', async () => {
    const { build } = setup(true);
    for (const uri of [URI.types, URI.story, URI.projects]) {
      const r = await read(build(CORE_TOOLS), uri);
      expect(findLeaks({ content: r.contents }), uri).toEqual([]);
    }
    const story = (await read(build(CORE_TOOLS), URI.story)).contents[0]?.text ?? '';
    expect(story).toContain('CANARY-7');
    expect(story).toContain('<untrusted-data');
    const projects = (await read(build(CORE_TOOLS), URI.projects)).contents[0]?.text ?? '';
    expect(projects).toContain('CANARY-1');
    expect(projects).toContain('<untrusted-data');
  });

  it('descriptions and the template list carry no instance words (A12)', async () => {
    const poisoned = setup(true);
    const templates = JSON.stringify(await rpc(poisoned.build(CORE_TOOLS), 'resources/templates/list'));
    expect(templates).not.toContain('CANARY');
    for (const d of RESOURCE_MANIFEST) expect(d.description).not.toMatch(/CANARY|Mobile App|Story:/);
  });
});

describe('audit', () => {
  it('a read is observed like a tool call: action, status, requests, no content', async () => {
    const { build, events } = setup();
    await read(build(CORE_TOOLS), URI.projects);
    await expect(read(build(CORE_TOOLS, { assetTypes: { deny: ['Story'] } }), URI.story)).rejects.toThrow();
    const ok = events.find((e) => e.tool === 'resource:workspace_projects');
    expect(ok).toMatchObject({ status: 'ok', errorCode: null });
    expect(ok?.requestsUsed).toBeGreaterThan(0);
    expect(events.find((e) => e.tool === 'resource:instance_asset_type')).toMatchObject({
      status: 'error',
      errorCode: 'AB_AUTH_FORBIDDEN',
    });
  });
});

describe('a custom manifest', () => {
  it('serves recipe-style entries added to the manifest (P6-03, P6-06) with the same rules', async () => {
    const extra: ResourceDefinition = {
      id: 'recipe_regression',
      uri: 'agility-bridge://recipes/regression',
      title: 'Regression recipe',
      description: 'How to query regression tests with query_assets (a test entry).',
      mimeType: 'text/markdown',
      source: 'static',
      uses: ['query_assets'],
      read: async () => ({ text: '# Regression\nUse query_assets.' }),
    };
    const make = (tools: readonly ToolDefinition[]) => () =>
      buildMcpServer({
        tools,
        ctx: () => makeContext({ fetch: new FakeAgility({ meta: SNAPSHOT }).fetch }),
        resources: [...RESOURCE_MANIFEST, extra],
      });
    expect((await list(make(CORE_TOOLS))).map((r) => r.uri)).toContain(extra.uri);
    expect((await read(make(CORE_TOOLS), extra.uri)).contents[0]?.text).toContain('Regression');
    expect((await list(make([tool('whoami')]))).map((r) => r.uri)).not.toContain(extra.uri);
  });
});
