// SPDX-License-Identifier: Apache-2.0
// P1-17: rows the recheck drops count as upstream positions, so paging never skips or repeats an in-scope row.
import { describe, expect, it } from 'vitest';
import { buildMcpServer, createBudget, MetadataService } from '../../src/index.ts';
import { queryAssets } from '../../src/tools/query/query-assets.ts';
import snapshotJson from '../fixtures/agility/meta-snapshot.json' with { type: 'json' };
import { FakeAgility, makeContext } from '../harness/index.ts';
import { rpc } from '../helpers/mcp.ts';

describe('paging with rows the upstream should not have returned', () => {
  it('walks every in-scope row exactly once', async () => {
    // Every third row belongs to another project; the fake ignores the scope filter, like a misbehaving upstream.
    const rows = Array.from({ length: 14 }, (_, i) => ({
      _oid: `Story:${100 + i}`,
      Number: `B-0${100 + i}`,
      Name: `Story ${i}`,
      AssetState: 64,
      Scope: i % 3 === 2 ? 'Scope:2000' : 'Scope:1001',
    }));
    const fake = new FakeAgility({
      meta: snapshotJson as unknown as Record<string, unknown>,
      filters: 'ignore-filters',
      assets: { Story: rows, Scope: [{ _oid: 'Scope:1001', ChildrenMeAndDown: ['Scope:1001'] }] },
    });
    const ctx = () =>
      makeContext({
        fetch: fake.fetch,
        metadata: new MetadataService(),
        budget: createBudget(100),
        projects: { allowed: ['Scope:1001'], includeChildren: true },
      });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await rpc(() => buildMcpServer({ tools: [queryAssets], ctx: ctx() }), 'tools/call', {
        name: 'query_assets',
        arguments: {
          asset_type: 'Story',
          fields: ['Name'],
          limit: 4,
          ...(cursor === undefined ? {} : { cursor }),
        },
      });
      const s = r['structuredContent'] as {
        items: Array<{ oid: string }>;
        nextCursor?: string;
        hiddenOutsideScope?: boolean;
      };
      seen.push(...s.items.map((i) => i.oid));
      cursor = s.nextCursor;
      if (cursor === undefined) break;
    }
    const expected = rows.filter((r) => r.Scope === 'Scope:1001').map((r) => r._oid);
    expect(seen).toEqual(expected);
  });
});
