// SPDX-License-Identifier: Apache-2.0
// P6-01 live check: the portfolio tools against the read-only tenant (L-148: the tree relation, the category and the
// aggregated child count were unverified until now). Every request goes through guardedFetch (P0-12); assertions are on
// shapes, counts and coarse levels only, nothing from the tenant is printed or kept. About 40 read requests, one at a
// time.
import { describe, expect, it } from 'vitest';
import {
  buildMcpServer,
  canonicalInstanceUrl,
  closedBreaker,
  createBudget,
  DEFAULT_LIMITS,
  MetadataService,
  Secret,
  Semaphore,
  silentLogger,
  systemClock,
  type ToolContext,
  webCryptoRandom,
} from '../packages/core/src/index.ts';
import { getPortfolioTree } from '../packages/core/src/tools/portfolio/get-tree.ts';
import { listPortfolioItems } from '../packages/core/src/tools/portfolio/list-items.ts';
import { rpc } from '../packages/core/test/helpers/mcp.ts';
import { liveTarget } from './env.ts';
import { guardedFetch } from './guarded-fetch.ts';

const target = liveTarget();

function liveContext(): ToolContext {
  if (target === undefined) throw new Error('no live target');
  return {
    requestId: crypto.randomUUID(),
    instance: { id: 'live', baseUrl: canonicalInstanceUrl(target.baseUrl) },
    workspace: {
      id: 'live',
      name: 'Live',
      groups: ['portfolio'],
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

type Out = Record<string, unknown>;
const call = async (
  tool: typeof listPortfolioItems,
  args: Record<string, unknown>,
  over: Partial<ToolContext> = {},
) => {
  const ctx: ToolContext = { ...liveContext(), metadata: new MetadataService(), ...over };
  const result = await rpc(() => buildMcpServer({ tools: [tool], ctx }), 'tools/call', {
    name: tool.name,
    arguments: args,
  });
  // Only the error code is ever shown: details can hold tenant names.
  const code = (result['_meta'] as Record<string, { code?: string }> | undefined)?.['agility-bridge/error']
    ?.code;
  return { result, code, ctx, out: (result['structuredContent'] ?? {}) as Out };
};
// Assertions are booleans with our own labels: a failing comparison must never print tenant values.
const ok = (condition: boolean, label: string) => expect(condition, label).toBe(true);
const hasNull = (v: unknown): boolean =>
  v === null || (typeof v === 'object' && Object.values(v as object).some(hasNull));
const bucket = (n: number) => (n === 0 ? 'none' : n < 100 ? 'some' : '100+');

describe.skipIf(!target)('portfolio tools against the live tenant (read-only)', () => {
  it('lists portfolio items with identity, category and the aggregated child count', {
    timeout: 120_000,
  }, async () => {
    const { code, out, ctx } = await call(listPortfolioItems, { limit: 25 });
    expect(code).toBeUndefined();
    const items = out['items'] as Out[];
    ok(items.length > 0, 'the first page has epics');
    for (const item of items) {
      ok(item['assetType'] === 'Epic', 'row is an epic');
      ok(typeof item['oid'] === 'string' && typeof item['number'] === 'string', 'row keeps its identity');
      ok(typeof item['state'] === 'string' && item['state'] !== 'deleted', 'row has a live state');
    }
    // The category (a value of Epic.Category, L-148) and the child count come back on at least some rows.
    ok(
      items.some((i) => typeof i['category'] === 'string'),
      'categories come back',
    );
    ok(
      items.some((i) => typeof i['childCount'] === 'number'),
      'the aggregated child count comes back',
    );
    ok(!hasNull(out), 'no null in the output');
    ok(ctx.budget.used <= listPortfolioItems.cost, 'within the declared cost');
    process.stderr.write(`live portfolio: epics on first page ${bucket(items.length)}\n`);
  });

  it('filters by a category found on the first page, pages, and keeps every row in that category', {
    timeout: 120_000,
  }, async () => {
    const first = await call(listPortfolioItems, { limit: 25 });
    const category = (first.out['items'] as Out[])
      .map((i) => i['category'])
      .find((c) => typeof c === 'string');
    if (typeof category !== 'string') return;
    const filtered = await call(listPortfolioItems, { category: [category], limit: 3 });
    expect(filtered.code).toBeUndefined();
    const rows = filtered.out['items'] as Out[];
    ok(rows.length > 0, 'the category has rows');
    ok(
      rows.every((r) => r['category'] === category),
      'every row is in the category',
    );
    if (typeof filtered.out['nextCursor'] === 'string') {
      const next = await call(listPortfolioItems, {
        category: [category],
        limit: 3,
        cursor: filtered.out['nextCursor'],
      });
      expect(next.code).toBeUndefined();
      const seen = new Set(rows.map((r) => r['oid']));
      ok(!(next.out['items'] as Out[]).some((r) => seen.has(r['oid'])), 'pages are disjoint');
    }
  });

  it('builds the tree of an epic that has children: levels, roll-ups and honest partial', {
    timeout: 180_000,
  }, async () => {
    const listed = await call(listPortfolioItems, { limit: 25 });
    const parents = (listed.out['items'] as Out[]).filter(
      (i) => typeof i['childCount'] === 'number' && (i['childCount'] as number) > 0,
    );
    ok(parents.length > 0, 'some epic has children');
    // Prefer an epic that has a sub-epic, so the tree has more than one level.
    const withParent = (listed.out['items'] as Out[]).find((i) => i['parent'] !== undefined);
    const rootOid = String(
      ((withParent?.['parent'] as Out | undefined)?.['oid'] as string | undefined) ?? parents[0]?.['oid'],
    );
    const { code, out, ctx } = await call(
      getPortfolioTree,
      { asset: rootOid, depth: 3, include_items: true },
      { budget: createBudget(60) },
    );
    expect(code).toBeUndefined();
    ok(out['root'] === rootOid, 'the root is the epic asked for');
    const nodes = out['nodes'] as Out[];
    ok(nodes.length > 0, 'the tree has nodes');
    ok(
      nodes[0]?.['oid'] === rootOid && nodes[0]?.['depth'] === 0 && nodes[0]?.['assetType'] === 'Epic',
      'the first node is the root',
    );
    for (const n of nodes) {
      ok(
        (n['itemCount'] as number) >= (n['doneItemCount'] as number) &&
          (n['itemCount'] as number) >= (n['openDefectCount'] as number),
        'counts are consistent',
      );
      if (typeof n['donePercent'] === 'number') {
        ok(n['donePercent'] >= 0 && n['donePercent'] <= 100, 'percentage in range');
        ok(n['donePercentBasis'] === 'estimate' || n['donePercentBasis'] === 'count', 'basis is stated');
      }
      if (n['depth'] !== 0)
        ok(typeof (n['parent'] as Out | undefined)?.['oid'] === 'string', 'a deeper node names its parent');
    }
    // Roll-ups never shrink going up: the root counts at least what each child counts.
    const root = nodes[0] as Out;
    ok(
      nodes.slice(1).every((n) => (root['itemCount'] as number) >= (n['itemCount'] as number)),
      'roll-ups do not shrink going up',
    );
    // A cut is never silent.
    if (nodes.some((n) => n['incomplete'] === true)) ok(out['partial'] === true, 'a cut is flagged partial');
    ok(!hasNull(out), 'no null in the result');
    ok(ctx.budget.used <= getPortfolioTree.cost, 'within the declared cost');
    const levels = new Set(nodes.map((n) => n['depth'])).size;
    process.stderr.write(
      `live portfolio: tree levels ${levels}, epics ${bucket(nodes.length)}, items counted ${bucket(root['itemCount'] as number)}, partial ${out['partial'] === true}\n`,
    );
  });

  it('refuses a work item that is not an epic, with the domain error and no data', {
    timeout: 60_000,
  }, async () => {
    const { code, out } = await call(getPortfolioTree, { asset: 'Story:1' });
    expect(['AB_INPUT_INVALID', 'AB_NOT_FOUND']).toContain(code);
    ok(out['nodes'] === undefined, 'no data on refusal');
  });
});
