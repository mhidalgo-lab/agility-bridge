// SPDX-License-Identifier: Apache-2.0
// P6-03 quality recipes: every example call compiles through the real query compiler against the committed metadata
// snapshot (a recipe cannot rot, L-292), the text is rendered from those examples, recipes exist only with their tools,
// and a denied type is refused with no upstream call.
import { describe, expect, it } from 'vitest';
import {
  buildMcpServer,
  CORE_TOOLS,
  createBudget,
  MetadataService,
  QUALITY_RECIPES,
  RESOURCE_MANIFEST,
  renderRecipe,
  type ToolDefinition,
} from '../src/index.ts';
import snapshotJson from './fixtures/agility/meta-snapshot.json' with { type: 'json' };
import { FakeAgility, makeContext } from './harness/index.ts';
import { rpc } from './helpers/mcp.ts';

const SNAPSHOT = snapshotJson as unknown as Record<string, unknown>;
const tool = (name: string): ToolDefinition => {
  const t = CORE_TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
};

type Reply = { isError?: boolean; content: Array<{ text: string }> };

function server(tools: readonly ToolDefinition[], over: Record<string, unknown> = {}) {
  const fake = new FakeAgility({
    meta: SNAPSHOT,
    assets: { Scope: [], Test: [], Defect: [], TestSet: [], RegressionTest: [] },
  });
  const build = () =>
    buildMcpServer({
      tools,
      ctx: () =>
        makeContext({
          fetch: fake.fetch,
          metadata: new MetadataService(),
          budget: createBudget(100),
          projects: { allowed: [], includeChildren: true },
          ...over,
        }),
    });
  return { fake, build };
}

describe('quality recipes', () => {
  const examples = QUALITY_RECIPES.flatMap((r) => r.examples.map((e) => ({ recipe: r.id, ...e })));

  it('has the two recipes with unique, static, instance-free text', () => {
    expect(QUALITY_RECIPES.map((r) => r.id)).toEqual([
      'recipe_tests_and_defects',
      'recipe_regression_assets',
    ]);
    for (const r of QUALITY_RECIPES) {
      expect(RESOURCE_MANIFEST.map((m) => m.id)).toContain(r.id);
      expect(renderRecipe(r)).not.toMatch(/CANARY|untrusted-data/);
    }
    expect(new Set(examples.map((e) => `${e.recipe}/${e.title}`)).size).toBe(examples.length);
  });

  it.each(examples.map((e) => [`${e.recipe}: ${e.title}`, e] as const))(
    'example validates through the real compiler: %s',
    async (_name, e) => {
      const { build } = server(CORE_TOOLS);
      const r = (await rpc(build, 'tools/call', { name: 'query_assets', arguments: e.input })) as Reply;
      expect(r.isError, r.content[0]?.text).toBeUndefined();
    },
  );

  it('reads as the rendered examples, one JSON block per example', async () => {
    const { build } = server(CORE_TOOLS);
    for (const r of QUALITY_RECIPES) {
      const read = (await rpc(build, 'resources/read', { uri: r.uri })) as {
        contents: Array<{ text: string; mimeType: string }>;
      };
      const text = read.contents[0]?.text ?? '';
      expect(read.contents[0]?.mimeType).toBe('text/markdown');
      expect(text).toBe(renderRecipe(r));
      for (const e of r.examples) expect(text).toContain(JSON.stringify(e.input));
    }
  });

  it('is offered only with the tools it is served through, and refused with no upstream call otherwise', async () => {
    const uris = QUALITY_RECIPES.map((r) => r.uri);
    const none = server([tool('whoami')]);
    for (const u of uris) await expect(rpc(none.build, 'resources/read', { uri: u })).rejects.toThrow();
    expect(none.fake.requests).toBe(0);
    const noQuery = server(CORE_TOOLS.filter((t) => t.name !== 'query_assets'));
    const listed = (await rpc(noQuery.build, 'resources/list')) as { resources: Array<{ uri: string }> };
    for (const u of uris) expect(listed.resources.map((r) => r.uri)).not.toContain(u);
    const before = noQuery.fake.requests;
    for (const u of uris) await expect(rpc(noQuery.build, 'resources/read', { uri: u })).rejects.toThrow();
    expect(noQuery.fake.requests).toBe(before);
    const all = server(CORE_TOOLS);
    const on = (await rpc(all.build, 'resources/list')) as { resources: Array<{ uri: string }> };
    for (const u of uris) expect(on.resources.map((r) => r.uri)).toContain(u);
  });

  it('never widens access: a denied type is refused by the tool, whatever the recipe says', async () => {
    const { build } = server(CORE_TOOLS, { assetTypes: { deny: ['Defect', 'Test'] } });
    for (const e of examples.filter((x) => ['Defect', 'Test'].includes(String(x.input['asset_type'])))) {
      const r = (await rpc(build, 'tools/call', { name: 'query_assets', arguments: e.input })) as Reply;
      expect(r.isError).toBe(true);
      expect(r.content[0]?.text).toMatch(/AB_AUTH_FORBIDDEN/);
    }
  });
});
