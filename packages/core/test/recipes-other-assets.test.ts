// SPDX-License-Identifier: Apache-2.0
// P6-06: issues, requests, goals, themes and retrospectives through the generic tools. Recipes are listed and readable
// only with their tools, every example runs through the real query compiler against the committed snapshot, default
// tiers are sensible per type, and a denied type or an out-of-scope row stays out (L-153, L-290, L-035, L-121).
import { describe, expect, it } from 'vitest';
import {
  buildMcpServer,
  CORE_TOOLS,
  createBudget,
  MetadataService,
  OTHER_ASSET_RECIPES,
  RESOURCE_MANIFEST,
  type ToolContext,
  type ToolDefinition,
} from '../src/index.ts';
import { metadataFor } from '../src/metadata/service.ts';
import snapshotJson from './fixtures/agility/meta-snapshot.json' with { type: 'json' };
import { FakeAgility, makeContext } from './harness/index.ts';
import { rpc } from './helpers/mcp.ts';

const SNAPSHOT = snapshotJson as unknown as Record<string, unknown>;
const TYPES = ['Issue', 'Request', 'Goal', 'Theme', 'Retrospective'] as const;
const PREFIX: Record<string, string> = {
  Issue: 'I',
  Request: 'R',
  Goal: 'G',
  Theme: 'TH',
  Retrospective: 'RE',
};
const tool = (name: string): ToolDefinition => {
  const t = CORE_TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
};
const RECIPE_URIS = OTHER_ASSET_RECIPES.map((r) => r.uri);

const row = (type: string, id: number, scope: string) => ({
  _oid: `${type}:${id}`,
  AssetType: type,
  ...(type === 'Retrospective' ? {} : { Number: `${PREFIX[type]}-0${id}` }),
  Name: `Synthetic ${type} ${id}`,
  AssetState: 64,
  Scope: scope,
  'Scope.Name': scope === 'Scope:1001' ? 'Mobile App' : 'Outside',
});

function setup(over: Partial<ToolContext> = {}) {
  const assets: Record<string, unknown[]> = {
    Scope: [
      { _oid: 'Scope:1001', Name: 'Mobile App', AssetState: 64, ChildrenMeAndDown: ['Scope:1001'] },
      { _oid: 'Scope:2000', Name: 'Outside', AssetState: 64, ChildrenMeAndDown: ['Scope:2000'] },
    ],
    Member: [{ _oid: 'Member:20', Name: 'Ann Example', Username: 'ann', AssetState: 64 }],
  };
  TYPES.forEach((t, i) => {
    assets[t] = [row(t, 100 + i, 'Scope:1001'), row(t, 200 + i, 'Scope:2000')];
  });
  assets['RequestStatus'] = [{ _oid: 'RequestStatus:1', Name: 'Open', Order: 1, Inactive: false }];
  const fake = new FakeAgility({ meta: SNAPSHOT, assets: assets as never });
  const ctx = (o: Partial<ToolContext> = {}): ToolContext =>
    makeContext({
      fetch: fake.fetch,
      metadata: new MetadataService(),
      budget: createBudget(100),
      projects: { allowed: ['Scope:1001'], includeChildren: true },
      ...over,
      ...o,
    });
  const build =
    (tools: readonly ToolDefinition[], o: Partial<ToolContext> = {}) =>
    () =>
      buildMcpServer({ tools, ctx: () => ctx(o) });
  return { fake, ctx, build };
}

type Build = ReturnType<ReturnType<typeof setup>['build']>;
const call = (build: Build, name: string, args: Record<string, unknown>) =>
  rpc(build, 'tools/call', { name, arguments: args });
const items = (r: Record<string, unknown>) =>
  (r['structuredContent'] as { items: Array<Record<string, unknown>> }).items;
const listUris = async (build: Build) => {
  try {
    return ((await rpc(build, 'resources/list')) as { resources: Array<{ uri: string }> }).resources.map(
      (r) => r.uri,
    );
  } catch (error) {
    if (/Method not found/.test(String(error))) return [];
    throw error;
  }
};
const read = (build: Build, uri: string) =>
  rpc(build, 'resources/read', { uri }) as Promise<{ contents: Array<{ text: string }> }>;

/** The JSON examples of a recipe, each tagged with the tool it is an input for. */
function examples(
  text: string,
): Array<{ tool: 'query_assets' | 'get_assets'; input: Record<string, unknown> }> {
  const out = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => {
    const input = JSON.parse(m[1] ?? '{}') as Record<string, unknown>;
    return {
      tool: ('asset_type' in input ? 'query_assets' : 'get_assets') as 'query_assets' | 'get_assets',
      input,
    };
  });
  return out;
}

describe('recipe resources', () => {
  it('four recipes, listed with every tool they use, each readable and covering the five types', async () => {
    expect(OTHER_ASSET_RECIPES).toHaveLength(4);
    for (const r of OTHER_ASSET_RECIPES) expect(RESOURCE_MANIFEST).toContain(r);
    const { build } = setup();
    const uris = await listUris(build(CORE_TOOLS));
    expect(uris).toEqual(expect.arrayContaining(RECIPE_URIS));
    const all: string[] = [];
    for (const uri of RECIPE_URIS) {
      const text = (await read(build(CORE_TOOLS), uri)).contents[0]?.text ?? '';
      expect(text.length).toBeGreaterThan(200);
      all.push(text);
    }
    for (const t of TYPES) expect(all.join('\n')).toContain(`"asset_type":"${t}"`);
  });

  it('is offered only when query_assets and get_assets are both allowed; refused with no upstream call otherwise', async () => {
    const { build, fake } = setup();
    for (const missing of ['query_assets', 'get_assets']) {
      const tools = CORE_TOOLS.filter((t) => t.name !== missing);
      const uris = await listUris(build(tools));
      for (const u of RECIPE_URIS) expect(uris).not.toContain(u);
      const before = fake.requests;
      for (const u of RECIPE_URIS) await expect(read(build(tools), u)).rejects.toThrow();
      expect(fake.requests).toBe(before);
    }
    expect(await listUris(build([tool('whoami')]))).toEqual([]);
  });

  it('carries no instance words and no secrets (A12)', () => {
    for (const r of OTHER_ASSET_RECIPES) {
      expect(r.description).not.toMatch(/CANARY|Mobile App|https?:/);
      expect(r.source).toBe('static');
    }
  });

  it('every example compiles through the real query compiler against the snapshot and runs', async () => {
    const { build } = setup();
    let count = 0;
    for (const r of OTHER_ASSET_RECIPES) {
      const text = (await read(build(CORE_TOOLS), r.uri)).contents[0]?.text ?? '';
      const found = examples(text);
      expect(found.length, r.id).toBeGreaterThanOrEqual(3);
      for (const e of found) {
        const res = await call(build([tool(e.tool)]), e.tool, e.input);
        expect(
          res['isError'],
          `${r.id}: ${JSON.stringify(e.input)}: ${JSON.stringify(res['content'])}`,
        ).toBeUndefined();
        count++;
      }
    }
    expect(count).toBeGreaterThanOrEqual(15);
  });
});

describe('default field tiers', () => {
  const expected: Record<string, { minimal: string[]; default: string[] }> = {
    Issue: {
      minimal: ['Number', 'Name', 'Scope.Name'],
      default: ['Owner.Name', 'Team.Name', 'ChangeDateUTC'],
    },
    Request: { minimal: ['Number', 'Name', 'Scope.Name'], default: ['Status.Name', 'ChangeDateUTC'] },
    Goal: { minimal: ['Number', 'Name', 'Scope.Name'], default: ['ChangeDateUTC'] },
    Theme: {
      minimal: ['Number', 'Name', 'Scope.Name'],
      default: ['Owners.Name', 'Timebox.Name', 'Team.Name', 'Parent.Number', 'ChangeDateUTC'],
    },
    Retrospective: { minimal: ['Name', 'Scope.Name'], default: ['ChangeDateUTC'] },
  };

  it.each(TYPES)(
    '%s: identity in minimal, status and owner in default, every path resolves',
    async (type) => {
      const { ctx } = setup();
      const md = metadataFor(ctx());
      const tiers = await md.fieldTiers(type);
      const want = expected[type] as { minimal: string[]; default: string[] };
      expect(tiers.minimal).toEqual(expect.arrayContaining(want.minimal));
      expect(tiers.default).toEqual(expect.arrayContaining([...want.minimal, ...want.default]));
      expect(tiers.default).not.toContain('Estimate');
      expect(tiers.full.length).toBeGreaterThanOrEqual(tiers.default.length);
      for (const p of new Set([...tiers.minimal, ...tiers.default, ...tiers.full]))
        await expect(md.resolvePath(type, p), `${type}.${p}`).resolves.toBeDefined();
    },
  );

  it('an owner list wins over the single owner (stories keep Owners.Name only)', async () => {
    const { ctx } = setup();
    const tiers = await metadataFor(ctx()).fieldTiers('Defect');
    expect(tiers.default).toContain('Owners.Name');
    expect(tiers.default).not.toContain('Owner.Name');
  });

  it.each(TYPES)(
    '%s: query_assets and get_assets return the default tier, scoped to the workspace',
    async (type) => {
      const { build } = setup();
      const r = await call(build([tool('query_assets')]), 'query_assets', { asset_type: type });
      expect(r['isError']).toBeUndefined();
      const rows = items(r);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.['assetType']).toBe(type);
      expect(JSON.stringify(rows)).not.toContain('Outside');
      const g = await call(build([tool('get_assets')]), 'get_assets', { assets: [String(rows[0]?.['oid'])] });
      expect(g['isError']).toBeUndefined();
      expect(items(g)).toHaveLength(1);
    },
  );
});

describe('descriptions of the types', () => {
  it('describe_asset_type works for all five and lists the Request statuses (L-288)', async () => {
    const { build } = setup();
    for (const type of TYPES) {
      const r = await call(build([tool('describe_asset_type')]), 'describe_asset_type', { asset_type: type });
      expect(r['isError'], type).toBeUndefined();
    }
    const req = await call(build([tool('describe_asset_type')]), 'describe_asset_type', {
      asset_type: 'Request',
    });
    expect(
      (req['structuredContent'] as { statuses: Array<{ name: string }> }).statuses.length,
    ).toBeGreaterThan(0);
  });

  it('each type is tied to an Agility project (direct scope)', async () => {
    const { ctx } = setup();
    for (const type of TYPES)
      expect(await metadataFor(ctx()).scopeStrategy(type), type).toEqual({ kind: 'direct', path: 'Scope' });
  });
});

describe('negative authorization', () => {
  it('a denied type is refused by the generic tools and by its resource, and nothing data-like is requested', async () => {
    for (const type of TYPES) {
      const { build, fake } = setup({ assetTypes: { deny: [type] } });
      const r = await call(build([tool('query_assets')]), 'query_assets', { asset_type: type });
      expect(r['isError'], type).toBe(true);
      expect(JSON.stringify(r)).toContain('AB_AUTH_FORBIDDEN');
      expect(fake.calls.filter((c) => !c.path.startsWith('meta.v1')).length, type).toBe(0);
      expect(await listUris(build(CORE_TOOLS))).not.toContain(
        `agility-bridge://instance/asset-types/${type}`,
      );
      await expect(read(build(CORE_TOOLS), `agility-bridge://instance/asset-types/${type}`)).rejects.toThrow(
        /AB_AUTH_FORBIDDEN/,
      );
    }
  });

  it('rows of another Agility project never appear, with or without a project argument', async () => {
    const { build } = setup();
    for (const type of TYPES) {
      const r = await call(build([tool('query_assets')]), 'query_assets', {
        asset_type: type,
        include_closed: true,
        fields: ['Name', 'Scope.Name'],
      });
      expect(JSON.stringify(items(r)), type).not.toContain('Outside');
      const outside = await call(build([tool('get_assets')]), 'get_assets', {
        assets: [`${type}:${type === 'Issue' ? 201 : 200 + TYPES.indexOf(type)}`],
      });
      expect(items(outside), type).toHaveLength(0);
    }
  });
});
