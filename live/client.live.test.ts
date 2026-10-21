// SPDX-License-Identifier: Apache-2.0
// P1-12 live suite: the production client, output shaper and metadata assumptions against the read-only tenant.
// Every request goes through guardedFetch (the P0-12 guard); the suite asserts on counts and shapes and prints nothing
// from the tenant. About 40 read requests, one at a time.
import { describe, expect, it } from 'vitest';
import {
  AbError,
  type AgilityClient,
  agilityClient,
  canonicalInstanceUrl,
  closedBreaker,
  createBudget,
  DEFAULT_LIMITS,
  metadataDrift,
  parseAssetType,
  Secret,
  Semaphore,
  shapeList,
  silentLogger,
  systemClock,
  type ToolContext,
  webCryptoRandom,
} from '../packages/core/src/index.ts';
import snapshotJson from '../packages/core/test/fixtures/agility/meta-snapshot.json' with { type: 'json' };
import { liveTarget } from './env.ts';
import { guardedFetch } from './guarded-fetch.ts';

const target = liveTarget();
const SNAPSHOT = snapshotJson as unknown as Record<string, unknown>;

function liveContext(): ToolContext {
  if (target === undefined) throw new Error('no live target');
  return {
    requestId: crypto.randomUUID(),
    instance: { id: 'live', baseUrl: canonicalInstanceUrl(target.baseUrl) },
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
});
