// SPDX-License-Identifier: Apache-2.0
// P1-12 live suite: the production client, output shaper and metadata assumptions against the read-only tenant.
// Every request goes through guardedFetch (the P0-12 guard); the suite asserts on counts and shapes and prints nothing
// from the tenant. About 40 read requests, one at a time.
import { describe, expect, it } from 'vitest';
import {
  AbError,
  type AgilityClient,
  agilityClient,
  buildMcpServer,
  canonicalInstanceUrl,
  closedBreaker,
  compileQuery,
  createBudget,
  DEFAULT_LIMITS,
  inScope,
  MetadataService,
  metadataDrift,
  parseAssetType,
  resolveAsset,
  resolveMember,
  resolveSprint,
  Secret,
  Semaphore,
  shapeList,
  silentLogger,
  systemClock,
  type ToolContext,
  webCryptoRandom,
} from '../packages/core/src/index.ts';
import { CORE_TOOLS } from '../packages/core/src/tools/index.ts';
import snapshotJson from '../packages/core/test/fixtures/agility/meta-snapshot.json' with { type: 'json' };
import { rpc } from '../packages/core/test/helpers/mcp.ts';
import { liveTarget } from './env.ts';
import { guardedFetch } from './guarded-fetch.ts';

const target = liveTarget();
const SNAPSHOT = snapshotJson as unknown as Record<string, unknown>;

function liveContext(): ToolContext {
  if (target === undefined) throw new Error('no live target');
  return {
    requestId: crypto.randomUUID(),
    instance: { id: 'live', baseUrl: canonicalInstanceUrl(target.baseUrl) },
    workspace: {
      id: 'live',
      name: 'Live',
      groups: ['core'],
      writes: { enabled: false, approval: 'unavailable' },
    },
    credential: { id: 'live', kind: 'personal', token: new Secret(target.token) },
    projects: { allowed: [], includeChildren: true },
    assetTypes: { deny: [] },
    limits: DEFAULT_LIMITS,
    budget: createBudget(100),
    limiter: new Semaphore(1),
    breaker: closedBreaker,
    fetch: guardedFetch(target),
    logger: silentLogger,
    clock: systemClock,
    random: webCryptoRandom,
  };
}

type Rows = Array<Array<Record<string, unknown>>>;

describe.skipIf(!target)('production client against the live tenant (read-only)', () => {
  let ctx: ToolContext;
  let client: AgilityClient;

  it('authenticates on query.v1 and spends one request', async () => {
    ctx = liveContext();
    client = agilityClient(ctx);
    const res = await client.query<Rows>({ from: 'Member', select: ['ID'], where: { IsSelf: 'true' } });
    expect(res.status).toBe(200);
    expect(res.data[0]).toHaveLength(1);
    expect(ctx.budget.used).toBe(1);
  });

  it('matches the committed metadata snapshot on product attributes (metadata drift, L-053)', {
    timeout: 120_000,
  }, async () => {
    const drift: string[] = [];
    for (const [type, body] of Object.entries(SNAPSHOT)) {
      // Synthetic custom types exist only in the fixture.
      if (type.startsWith('Custom_')) continue;
      const expected = parseAssetType(body);
      let actual: ReturnType<typeof parseAssetType> | undefined;
      try {
        const res = await client.meta(type);
        expect(res.etag ?? '').toMatch(/^"[0-9.]+"$/);
        actual = parseAssetType(res.data);
      } catch (error) {
        if (!(error instanceof AbError) || error.code !== 'AB_NOT_FOUND') throw error;
      }
      drift.push(...metadataDrift(expected, actual));
    }
    // Product attribute names only (custom attributes are never compared): safe to print.
    expect(drift).toEqual([]);
  });

  it('pages by ID without overlap and learns "more available" from limit + 1', async () => {
    const page = async (start: number) =>
      (
        await client.query<Rows>({
          from: 'Story',
          select: ['Number'],
          sort: ['ID'],
          page: { start, size: 6 },
        })
      ).data[0] ?? [];
    const first = await page(0);
    const second = await page(5);
    expect(first).toHaveLength(6);
    const firstFive = new Set(first.slice(0, 5).map((r) => r['_oid']));
    expect(second.some((r) => firstFive.has(r['_oid']))).toBe(false);
    expect(second[0]?.['_oid']).toBe(first[5]?.['_oid']);
  });

  it('shapes real rows into an envelope with structured items equal to the rows shown', async () => {
    const res = await client.query<Rows>({
      from: 'Story',
      select: ['Number', 'Name', 'Status.Name', 'Scope.Name', 'AssetState', 'Description'],
      sort: ['ID'],
      page: { start: 0, size: 5 },
    });
    const rows = (res.data[0] ?? []).map((r) => ({
      number: r['Number'],
      assetType: 'Story',
      oid: r['_oid'],
      name: r['Name'],
      status: r['Status.Name'],
      project: { name: r['Scope.Name'] },
      description: r['Description'],
    }));
    const out = shapeList(ctx, {
      summary: `${rows.length} stories.`,
      source: 'stories',
      rows,
      richText: ['description'],
      format: 'json',
    });
    const items = (out.structured as { items: unknown[] }).items;
    expect(items).toHaveLength(rows.length);
    expect(out.text.match(/^<untrusted-data id="[0-9a-f]{16}" source="stories">$/m)).not.toBeNull();
    expect(JSON.stringify(out.structured)).not.toContain('null');
  });

  it('runs every compiled query shape on the tenant (scope strategies, dead-asset filters, aggregations)', {
    timeout: 120_000,
  }, async () => {
    const scopes = await client.query<Rows>({
      from: 'Scope',
      select: ['ID'],
      sort: ['ID'],
      page: { start: 0, size: 1 },
    });
    const scope = String(scopes.data[0]?.[0]?.['_oid'] ?? '');
    expect(scope).toMatch(/^Scope:\d+$/);
    const scoped: ToolContext = {
      ...ctx,
      metadata: new MetadataService(),
      projects: { allowed: [scope], includeChildren: true },
    };
    const cases = [
      {
        assetType: 'Story',
        fields: ['Number', 'Status.Name', 'Children.@Count', 'Actuals.Value.@Sum'],
        anyOf: [
          [{ field: 'Estimate', op: 'ge' as const, value: 1 }],
          [{ field: 'Timebox', op: 'is_set' as const }],
        ],
      },
      {
        assetType: 'Defect',
        fields: ['Number'],
        filters: [{ field: 'Name', op: 'contains' as const, value: "zz'|(" }],
        includeClosed: true,
      },
      { assetType: 'Task', fields: ['Number', 'Parent:Story.Number'] },
      { assetType: 'Attachment', fields: ['Name'] },
      { assetType: 'Scope', fields: ['Name'] },
      { assetType: 'Timebox', fields: ['Name', 'BeginDate'] },
      { assetType: 'Actual', fields: ['Value'] },
      { assetType: 'Story', fields: ['Number'], asOf: new Date(Date.now() - 7 * 86_400_000).toISOString() },
    ];
    for (const input of cases) {
      const q = await compileQuery(scoped, { ...input, limit: 2 });
      const res = await agilityClient(scoped).query<Rows>(q.body);
      // Counts only: each shape is valid query.v1 and returns at most limit + 1 rows.
      expect(res.status, input.assetType).toBe(200);
      expect((res.data[0] ?? []).length).toBeLessThanOrEqual(3);
    }
  });

  it('resolves identifiers on the tenant and every scoped row passes the recheck (P1-06)', {
    timeout: 120_000,
  }, async () => {
    const fresh: ToolContext = { ...ctx, metadata: new MetadataService(), budget: createBudget(60) };
    expect((await resolveMember(fresh, 'me')).oid).toMatch(/^Member:\d+$/);
    const sample = await agilityClient(fresh).query<Rows>({
      from: 'Story',
      select: ['Number', 'Scope'],
      sort: ['ID'],
      page: { start: 0, size: 1 },
    });
    const row = sample.data[0]?.[0] ?? {};
    const number = String(row['Number'] ?? '');
    const resolved = await resolveAsset(fresh, number);
    expect(resolved.oid).toBe(row['_oid']);
    expect(resolved.assetType).toBe('Story');
    const scope = String((row['Scope'] as { _oid?: string } | undefined)?._oid ?? '');
    expect(scope).toMatch(/^Scope:\d+$/);
    const scoped: ToolContext = { ...fresh, projects: { allowed: [scope], includeChildren: true } };
    expect((await resolveAsset(scoped, number)).oid).toBe(row['_oid']);
    for (const assetType of ['Story', 'Timebox']) {
      const q = await compileQuery(scoped, { assetType, fields: ['Name'], limit: 5 });
      const rows = ((await agilityClient(scoped).query<Rows>(q.body)).data[0] ?? []) as Array<
        Record<string, unknown>
      >;
      expect(
        rows.every((r) => inScope(scoped, q, r)),
        assetType,
      ).toBe(true);
    }
    try {
      await resolveSprint(scoped, 'current');
    } catch (error) {
      expect(error instanceof AbError && ['AB_AMBIGUOUS', 'AB_NOT_FOUND'].includes(error.code)).toBe(true);
    }
  });

  it('runs every catalogue tool on the tenant without an error (counts only)', {
    timeout: 180_000,
  }, async () => {
    const sample = await agilityClient(ctx).query<Rows>({
      from: 'Defect',
      select: ['Number'],
      sort: ['ID'],
      page: { start: 0, size: 1 },
    });
    const defect = String(sample.data[0]?.[0]?.['Number'] ?? 'D-00000');
    const argsFor: Record<string, Record<string, unknown>> = {
      describe_asset_type: { asset_type: 'Story' },
      query_assets: { asset_type: 'Defect', fields: ['Name', 'Status.Name', 'Description'], limit: 3 },
      get_assets: { assets: [defect, 'B-0', 'Story:1'] },
      search_work_items: { member: 'me', limit: 3 },
      get_work_item: { asset: defect },
      list_my_work: { limit: 3 },
    };
    for (const tool of CORE_TOOLS) {
      const fresh: ToolContext = { ...ctx, metadata: new MetadataService(), budget: createBudget(60) };
      const args = argsFor[tool.name] ?? {};
      const result = await rpc(() => buildMcpServer({ tools: [tool], ctx: fresh }), 'tools/call', {
        name: tool.name,
        arguments: args,
      });
      // Only the error code is printed on failure: details can hold Agility names.
      const code = (result['_meta'] as Record<string, { code?: string }> | undefined)?.[
        'agility-bridge/error'
      ]?.code;
      expect(code, tool.name).toBeUndefined();
      expect(fresh.budget.used, tool.name).toBeLessThanOrEqual(tool.cost);
    }
  });

  it('answers current-sprint searches with items or a clean ambiguity, never an Agility error', {
    timeout: 120_000,
  }, async () => {
    const tool = CORE_TOOLS.find((t) => t.name === 'search_work_items');
    if (tool === undefined) return;
    const fresh: ToolContext = { ...ctx, metadata: new MetadataService(), budget: createBudget(60) };
    const result = await rpc(() => buildMcpServer({ tools: [tool], ctx: fresh }), 'tools/call', {
      name: tool.name,
      arguments: { sprint: 'current', limit: 3 },
    });
    const code = (result['_meta'] as Record<string, { code?: string }> | undefined)?.['agility-bridge/error']
      ?.code;
    expect([undefined, 'AB_AMBIGUOUS', 'AB_NOT_FOUND']).toContain(code);
  });
});
