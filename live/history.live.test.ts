// SPDX-License-Identifier: Apache-2.0
// P6-05 live suite: the history tools against the read-only tenant. The tenant is read-only and third-party, so
// "history matches known edits" cannot be checked here (gap for the writable sandbox, docs/dev/verification.md); this
// checks shapes and consistency instead: the latest history value agrees with the current one, windows hold, and the
// recently-changed list is inside its window and ordered. Assertions carry labels and booleans only, never values.
import { describe, expect, it } from 'vitest';
import {
  agilityClient,
  buildMcpServer,
  canonicalInstanceUrl,
  closedBreaker,
  createBudget,
  DEFAULT_LIMITS,
  MetadataService,
  richText,
  Secret,
  Semaphore,
  silentLogger,
  systemClock,
  type ToolContext,
  webCryptoRandom,
} from '../packages/core/src/index.ts';
import { CORE_TOOLS } from '../packages/core/src/tools/index.ts';
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

const tool = (name: string) => {
  const t = CORE_TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
};

async function run(name: string, args: Record<string, unknown>) {
  const ctx: ToolContext = { ...liveContext(), metadata: new MetadataService(), budget: createBudget(60) };
  const result = await rpc(() => buildMcpServer({ tools: [tool(name)], ctx }), 'tools/call', {
    name,
    arguments: args,
  });
  // Only the code is checked: error details can hold tenant text.
  const code = (result['_meta'] as Record<string, { code?: string }> | undefined)?.['agility-bridge/error']
    ?.code;
  expect(code, `${name} error code`).toBeUndefined();
  expect(result['isError'], `${name} isError`).toBeUndefined();
  return {
    structured: result['structuredContent'] as Record<string, unknown>,
    used: ctx.budget.used,
    cost: tool(name).cost,
  };
}

type Item = Record<string, unknown>;

describe.skipIf(!target)('history tools against the live tenant (read-only)', () => {
  const recent: { assets: Array<{ oid: string; type: string }> } = { assets: [] };

  it('list_recent_changes returns items inside the window, newest change first within a type', {
    timeout: 120_000,
  }, async () => {
    const { structured, used, cost } = await run('list_recent_changes', {
      time_range: 'last 30 days',
      limit: 10,
    });
    const items = structured['items'] as Item[];
    const window = structured['window'] as { since: string; until: string };
    expect(used <= cost, 'within the declared cost').toBe(true);
    expect(items.length > 0, 'at least one item changed in 30 days').toBe(true);
    const times = items.map((i) => Date.parse(String(i['changedAt'])));
    expect(
      times.every((t) => Number.isFinite(t)),
      'every item has a UTC changedAt',
    ).toBe(true);
    expect(
      times.every((t) => t >= Date.parse(window.since) && t < Date.parse(window.until)),
      'every change is inside the window',
    ).toBe(true);
    for (const type of new Set(items.map((i) => i['assetType']))) {
      const own = items.filter((i) => i['assetType'] === type).map((i) => Date.parse(String(i['changedAt'])));
      expect(
        own.every((t, i) => i === 0 || (own[i - 1] as number) >= t),
        'newest change first within a type',
      ).toBe(true);
    }
    recent.assets = items.slice(0, 5).map((i) => ({ oid: String(i['oid']), type: String(i['assetType']) }));
  });

  it('get_asset_history agrees with the current values and the window holds (consistency, not known edits)', {
    timeout: 120_000,
  }, async () => {
    expect(recent.assets.length > 0, 'recently changed assets from the previous check').toBe(true);
    // Epics (in list_recent_changes since P6-22) carry their estimate as Swag; backlog items as Estimate.
    const fieldsOf = (type: string) => ['Name', 'Status.Name', type === 'Epic' ? 'Swag' : 'Estimate'];
    let compared = 0;
    const mismatches: string[] = [];
    // One asset at a time, each with its own request budget.
    for (const { oid, type } of recent.assets) {
      const fields = fieldsOf(type);
      const { structured, used, cost } = await run('get_asset_history', {
        asset: oid,
        time_range: 'last 365 days',
        fields,
        limit: 100,
      });
      expect(used <= cost, 'within the declared cost').toBe(true);
      const items = structured['items'] as Item[];
      const versions = structured['versions'] as { total: number; inWindow: number };
      expect(versions.total >= 1, 'Hist returned versions of this asset').toBe(true);
      expect(versions.inWindow <= versions.total, 'window versions are a subset').toBe(true);
      const window = structured['window'] as { since: string; until: string };
      expect(
        items.every((i) => {
          const t = Date.parse(String(i['changedAt']));
          return t >= Date.parse(window.since) && t < Date.parse(window.until);
        }),
        'every row is inside the window',
      ).toBe(true);
      const order = items.map((i) => Number(i['version']));
      expect(
        order.every((v, i) => i === 0 || (order[i - 1] as number) >= v),
        'newest version first',
      ).toBe(true);

      // The newest change of each followed field equals the current value read through query.v1.
      const current = (
        await agilityClient(liveContext()).query<Item[][]>({
          from: type,
          select: fields,
          filter: ['ID=$id'],
          with: { $id: oid },
        })
      ).data[0]?.[0];
      expect(current, 'the asset is readable').toBeDefined();
      for (const field of fields) {
        const latest = items.find((i) => i['field'] === field);
        if (latest === undefined) continue; // unchanged in the window: nothing to compare
        compared++;
        const now = (current as Item)[field];
        const shown = latest['to'];
        const same =
          now === null || now === undefined
            ? shown === undefined
            : typeof now === 'string'
              ? String(shown) === richText(now).slice(0, 500)
              : shown === now;
        if (!same) mismatches.push(field);
      }
    }
    expect(compared > 0, 'at least one followed field changed on a sampled asset').toBe(true);
    // Product attribute names only: safe to print.
    expect(mismatches, 'fields whose newest history value differs from the current value').toEqual([]);
  });

  it('refuses an over-long window with no Agility request', async () => {
    const ctx: ToolContext = { ...liveContext(), metadata: new MetadataService() };
    const result = await rpc(
      () => buildMcpServer({ tools: [tool('get_asset_history')], ctx }),
      'tools/call',
      {
        name: 'get_asset_history',
        arguments: { asset: 'B-00001', time_range: 'last 4000 days' },
      },
    );
    expect(result['isError']).toBe(true);
    expect(ctx.budget.used).toBe(0);
  });
});
