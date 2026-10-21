// SPDX-License-Identifier: Apache-2.0
// Phase 1 review (docs/reviews/phase-1-review.md): one regression test per finding; each fails with its fix reverted.
import { describe, expect, it } from 'vitest';
import {
  AbError,
  buildMcpServer,
  CircuitBreakers,
  compileQuery,
  createBudget,
  envelopeRenderer,
  htmlToText,
  MetadataService,
  metadataFor,
  minimiseEmails,
  parseInstant,
  type ToolContext,
  type ToolDefinition,
} from '../src/index.ts';
import { listMembers } from '../src/tools/planning/members.ts';
import { queryAssets } from '../src/tools/query/query-assets.ts';
import { getWorkItem } from '../src/tools/work/get-item.ts';
import { multiPage, type TypedRow } from '../src/tools/work/multi.ts';
import snapshotJson from './fixtures/agility/meta-snapshot.json' with { type: 'json' };
import { FakeAgility, type FakeAgilityOptions, makeContext } from './harness/index.ts';
import { RLO, ZWSP } from './helpers/chars.ts';
import { rpc } from './helpers/mcp.ts';

const SNAPSHOT = snapshotJson as unknown as Record<string, unknown>;
const inScope = { Scope: 'Scope:1001', 'Scope.Name': 'Mobile App' };

function setup(assets: NonNullable<FakeAgilityOptions['assets']>, over: Partial<ToolContext> = {}) {
  const fake = new FakeAgility({
    meta: SNAPSHOT,
    assets: {
      Scope: [
        {
          _oid: 'Scope:1001',
          Name: 'Mobile App',
          AssetState: 64,
          ChildrenMeAndDown: ['Scope:1001'],
          Members: ['Member:20'],
        },
      ],
      ...assets,
    },
  });
  const ctx = (o: Partial<ToolContext> = {}) =>
    makeContext({
      fetch: fake.fetch,
      metadata: new MetadataService(),
      budget: createBudget(200),
      projects: { allowed: ['Scope:1001'], includeChildren: true },
      ...over,
      ...o,
    });
  return { fake, ctx };
}

const call = (tool: ToolDefinition, ctx: ToolContext, args: Record<string, unknown>) =>
  rpc(() => buildMcpServer({ tools: [tool], ctx }), 'tools/call', { name: tool.name, arguments: args });
const text = (r: Record<string, unknown>) => (r['content'] as Array<{ text: string }>)[0]?.text ?? '';
async function failure(p: Promise<unknown>): Promise<AbError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AbError) return e;
    throw e;
  }
  throw new Error('expected a failure');
}

describe('H1: rich text conversion stays linear on hostile descriptions', () => {
  it('bounds nested lists, nested links and input size', () => {
    const t = performance.now();
    const lists = htmlToText(`${'<ul>'.repeat(4_000)}${'<li>x'.repeat(4_000)}`);
    const links = htmlToText(`${'<a href="https://example.com">'.repeat(20_000)}x${'</a>'.repeat(20_000)}`);
    const big = htmlToText(`<p>${'y'.repeat(500_000)}</p>`);
    expect(performance.now() - t).toBeLessThan(2_000);
    expect(lists.length).toBeLessThan(200_000);
    expect(links.length).toBeLessThan(10_000);
    expect(big.length).toBeLessThanOrEqual(65_536);
  });
});

describe('H2: related assets outside the workspace stay outside', () => {
  const stories = [
    {
      _oid: 'Story:1',
      AssetType: 'Story',
      Number: 'B-1',
      Name: 'In scope',
      AssetState: 64,
      ...inScope,
      Super: 'Epic:9',
      'Super.Description': 'Secret plan of another project',
      'Super.Scope': 'Scope:2000',
    },
    {
      _oid: 'Story:2',
      AssetType: 'Story',
      Number: 'B-2',
      Name: 'Also in scope',
      AssetState: 64,
      ...inScope,
      Super: 'Epic:8',
      'Super.Description': 'Our epic',
      'Super.Scope': 'Scope:1001',
    },
  ];

  it('drops values of a related asset outside the workspace and keeps those inside', async () => {
    const { ctx } = setup({ Story: stories });
    const r = await call(queryAssets, ctx(), { asset_type: 'Story', fields: ['Name', 'Super.Description'] });
    expect(JSON.stringify(r)).not.toContain('Secret plan');
    expect(JSON.stringify(r)).toContain('Our epic');
  });

  it('guards filters through related assets, so they are no oracle', async () => {
    const q = await compileQuery(setup({}).ctx(), {
      assetType: 'Story',
      fields: ['Name'],
      filters: [{ field: 'Super.Name', op: 'eq', value: 'x' }],
    });
    expect(q.body['filter']).toContain('(Super.Name=$v1;Super.Scope=$ab_scope)');
  });

  it('refuses member emails and usernames through relations, and denied or multi-value scoped targets', async () => {
    const c = setup({}).ctx();
    for (const fields of [['Owners.Email'], ['Owners.Username'], ['Children.Name']]) {
      expect((await failure(compileQuery(c, { assetType: 'Story', fields }))).code, fields[0]).toBe(
        'AB_AUTH_FORBIDDEN',
      );
    }
    // Another project's description through the project tree is guarded, not refused.
    const parent = await compileQuery(c, { assetType: 'Story', fields: ['Scope.Parent.Description'] });
    expect(parent.guards).toEqual([{ key: 'Scope.Parent.Description', guards: ['Scope.Parent'] }]);
    expect(
      (
        await failure(
          compileQuery(setup({}, { assetTypes: { deny: ['Epic'] } }).ctx(), {
            assetType: 'Story',
            fields: ['Super.Name'],
          }),
        )
      ).code,
    ).toBe('AB_AUTH_FORBIDDEN');
    await expect(
      compileQuery(c, { assetType: 'Story', fields: ['Children.@Count', 'Owners.Name'] }),
    ).resolves.toBeDefined();
    const withEmails = setup({}, { limits: { ...makeContext().limits, memberEmails: true } }).ctx();
    await expect(
      compileQuery(withEmails, { assetType: 'Story', fields: ['Owners.Email'] }),
    ).resolves.toBeDefined();
  });

  it('drops email and username keys at any path depth', () => {
    expect(
      minimiseEmails({ 'Owners.Email': ['a@example.com'], 'Owners.Username': ['ann'], Name: 'x' }),
    ).toEqual({ Name: 'x' });
  });
});

describe('M1: server-built lists may exceed the caller limit of 50 values', () => {
  it('compiles a trusted list of 2,000 and refuses an untrusted one of 60', async () => {
    const c = setup({}).ctx();
    const ids = Array.from({ length: 2_000 }, (_, i) => `Member:${i + 1}`);
    await expect(
      compileQuery(
        c,
        {
          assetType: 'Member',
          fields: ['Name'],
          filters: [{ field: 'ID', op: 'in', value: ids, trusted: true }],
        },
        { allowGlobal: true },
      ),
    ).resolves.toBeDefined();
    expect(
      (
        await failure(
          compileQuery(
            c,
            {
              assetType: 'Member',
              fields: ['Name'],
              filters: [{ field: 'ID', op: 'in', value: ids.slice(0, 60) }],
            },
            { allowGlobal: true },
          ),
        )
      ).code,
    ).toBe('AB_INPUT_INVALID');
  });
});

describe('M2: multi-type pages never skip or repeat, whatever the comparator', () => {
  it('walks every row exactly once with a comparator that disagrees with Agility', async () => {
    const story = (i: number) => ({
      _oid: `Story:${i}`,
      Number: `B-${i}`,
      Name: `s${i}`,
      AssetState: 64,
      ...inScope,
    });
    const defect = (i: number) => ({
      _oid: `Defect:${i}`,
      Number: `D-${i}`,
      Name: `d${i}`,
      AssetState: 64,
      ...inScope,
    });
    const { ctx } = setup({ Story: [1, 3, 5, 7, 9].map(story), Defect: [2, 4, 6].map(defect) });
    // Reverse of Agility's ID order: a merge that sorts everything would skip and repeat rows.
    const reverse = (a: TypedRow, b: TypedRow) => String(b.row['_oid']).localeCompare(String(a.row['_oid']));
    const seen: string[] = [];
    let offsets: Record<string, number> = {};
    for (let page = 0; page < 10; page++) {
      const p = await multiPage(
        ctx(),
        ['Story', 'Defect'].map((type) => ({ type, input: { assetType: type, fields: ['Name'] } })),
        2,
        offsets,
        reverse,
        () => [],
      );
      seen.push(...p.rows.map((r) => String(r.row['_oid'])));
      offsets = { ...p.offsets };
      if (!p.hasMore) break;
    }
    expect([...seen].sort()).toEqual([
      'Defect:2',
      'Defect:4',
      'Defect:6',
      'Story:1',
      'Story:3',
      'Story:5',
      'Story:7',
      'Story:9',
    ]);
  });
});

describe('M4, M5, M6', () => {
  it('get_work_item leaves out sections the workspace does not allow', async () => {
    const { ctx } = setup({
      Story: [{ _oid: 'Story:1', AssetType: 'Story', Number: 'B-1', Name: 'x', AssetState: 64, ...inScope }],
      Workitem: [],
    });
    const r = await call(getWorkItem, ctx({ assetTypes: { allow: ['Story'], deny: [] } }), {
      asset: 'Story:1',
    });
    expect(r['isError'], text(r)).toBeUndefined();
    expect(text(r)).toContain('Not shown, not allowed in this workspace: Task, Test, Link, Expression.');
  });

  it('list_members hides usernames unless emails are enabled', async () => {
    const { ctx } = setup({
      Member: [{ _oid: 'Member:20', Name: 'Ann', Username: 'ann@example.com', AssetState: 64 }],
    });
    expect(JSON.stringify(await call(listMembers, ctx(), {}))).not.toContain('ann@example.com');
  });

  it('asks Agility about at most three unknown asset types per call', async () => {
    const { ctx, fake } = setup({});
    const md = metadataFor(ctx());
    for (const t of ['Nope1', 'Nope2', 'Nope3', 'Nope4', 'Nope5']) await md.findAssetType(t);
    expect(fake.calls.filter((c) => c.path.startsWith('meta.v1/Nope'))).toHaveLength(3);
  });
});

describe('lows', () => {
  it('cleans error details before enveloping them', () => {
    const out = envelopeRenderer('abababababababab')(`untrusted${ZWSP}-data ${RLO}x`, 'error details');
    expect(out).not.toContain(ZWSP);
    expect(out).not.toContain(RLO);
  });

  it('refuses timestamps on days that do not exist', () => {
    expect(() => parseInstant('2026-02-31T00:00:00Z')).toThrow(/not a date/);
  });

  it('clamps an absurd Retry-After to an hour', () => {
    let now = 0;
    const b = new CircuitBreakers({ threshold: 1, clock: { now: () => now } }).for('i', 'c');
    b.onRateLimited(10 * 365 * 86_400_000);
    now = 3_600_001;
    expect(b.openForMs()).toBe(0);
  });

  it('reads aggregation values by the key Agility answers with', async () => {
    const { ctx } = setup({
      Story: [
        {
          _oid: 'Story:1',
          Number: 'B-1',
          AssetState: 64,
          ...inScope,
          "Children[AssetState!='Dead'].@Count": '4',
        },
      ],
    });
    const r = await call(queryAssets, ctx(), { asset_type: 'Story', fields: ['Children.@Count'] });
    expect(
      (r['structuredContent'] as { items: Array<Record<string, unknown>> }).items[0]?.['Children.@Count'],
    ).toBe(4);
  });
});
