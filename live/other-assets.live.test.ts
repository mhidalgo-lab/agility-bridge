// SPDX-License-Identifier: Apache-2.0
// P6-06 live suite: issues, requests, goals, themes and retrospectives through query_assets and get_assets with default
// tiers, against the read-only tenant (every request goes through the P0-12 guard, one at a time). Types the tenant does
// not hold are recorded as absent (a gap for the writable sandbox, P6-27). Assertions and the git-ignored results file hold
// levels and shapes only: no names, ids, URLs or custom attribute names are printed or committed.
import { mkdirSync, writeFileSync } from 'node:fs';
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
import { getAssets } from '../packages/core/src/tools/query/get-assets.ts';
import { queryAssets } from '../packages/core/src/tools/query/query-assets.ts';
import { rpc } from '../packages/core/test/helpers/mcp.ts';
import { liveTarget } from './env.ts';
import { guardedFetch } from './guarded-fetch.ts';

const target = liveTarget();
const TYPES = ['Issue', 'Request', 'Goal', 'Theme', 'Retrospective'] as const;

function liveContext(metadata: MetadataService): ToolContext {
  if (target === undefined) throw new Error('no live target');
  return {
    requestId: crypto.randomUUID(),
    instance: { id: 'live', baseUrl: canonicalInstanceUrl(target.baseUrl) },
    workspace: {
      id: 'live',
      name: 'Live',
      groups: ['core', 'query'],
      writes: { enabled: false, approval: 'unavailable' },
    },
    credential: { id: 'live', kind: 'personal', token: new Secret(target.token) },
    projects: { allowed: [], includeChildren: true },
    assetTypes: { deny: [] },
    limits: DEFAULT_LIMITS,
    budget: createBudget(60),
    limiter: new Semaphore(1),
    breaker: closedBreaker,
    fetch: guardedFetch(target),
    metadata,
    logger: silentLogger,
    clock: systemClock,
    random: webCryptoRandom,
  };
}

const code = (r: Record<string, unknown>) =>
  (r['_meta'] as Record<string, { code?: string }> | undefined)?.['agility-bridge/error']?.code;

describe.skipIf(!target)(
  'other asset types through the generic tools against the live tenant (read-only)',
  () => {
    it('each type answers query_assets and get_assets with its default tier; absent types are recorded', {
      timeout: 240_000,
    }, async () => {
      const metadata = new MetadataService();
      const levels: Record<string, string> = {};
      for (const type of TYPES) {
        const q = await rpc(
          () => buildMcpServer({ tools: [queryAssets], ctx: liveContext(metadata) }),
          'tools/call',
          { name: 'query_assets', arguments: { asset_type: type, limit: 3, include_closed: true } },
        );
        if (q['isError'] === true) {
          // A type the instance does not define is an input error, not a failure of the tool.
          expect(['AB_INPUT_INVALID', 'AB_NOT_FOUND', 'AB_AUTH_FORBIDDEN'], type).toContain(code(q));
          levels[type] = `unavailable:${code(q)}`;
          continue;
        }
        const rows = (q['structuredContent'] as { items: Array<Record<string, unknown>> }).items;
        if (rows.length === 0) {
          levels[type] = 'absent';
          continue;
        }
        levels[type] = rows.length >= 3 ? 'present (3+)' : 'present';
        for (const r of rows) {
          expect(r['assetType'], type).toBe(type);
          expect(typeof r['oid'], type).toBe('string');
        }
        const g = await rpc(
          () => buildMcpServer({ tools: [getAssets], ctx: liveContext(metadata) }),
          'tools/call',
          { name: 'get_assets', arguments: { assets: [String(rows[0]?.['oid'])] } },
        );
        expect(g['isError'], type).toBeUndefined();
        expect((g['structuredContent'] as { items: unknown[] }).items, type).toHaveLength(1);
      }
      mkdirSync('live/results', { recursive: true });
      writeFileSync(
        'live/results/other-assets.json',
        `${JSON.stringify({ date: new Date().toISOString().slice(0, 10), levels }, null, 2)}\n`,
      );
      expect(Object.keys(levels)).toHaveLength(TYPES.length);
    });
  },
);
