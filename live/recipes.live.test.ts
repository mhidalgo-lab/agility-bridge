// SPDX-License-Identifier: Apache-2.0
// P6-03 live suite: every example call of the quality recipes against the read-only tenant. Every request goes through guardedFetch
// (the P0-12 guard); the suite asserts on counts and shapes only and prints nothing from the tenant: no names, ids,
// URLs or custom attribute names. Types the tenant lacks are tallied, not failed. One request at a time.
import { describe, expect, it } from 'vitest';
import {
  buildMcpServer,
  canonicalInstanceUrl,
  closedBreaker,
  createBudget,
  DEFAULT_LIMITS,
  MetadataService,
  QUALITY_RECIPES,
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

function liveContext(metadata: MetadataService): ToolContext {
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
    metadata,
    logger: silentLogger,
    clock: systemClock,
    random: webCryptoRandom,
  };
}

describe.skipIf(!target)('quality recipes against the live tenant (read-only)', () => {
  it('runs every example: tests and defects must succeed, absent types are a recorded gap', {
    timeout: 300_000,
  }, async () => {
    const metadata = new MetadataService();
    const build = () => buildMcpServer({ tools: CORE_TOOLS, ctx: () => liveContext(metadata) });
    const tally = { ok: 0, rows: 0, absentOrRefused: 0 };
    for (const recipe of QUALITY_RECIPES) {
      for (const example of recipe.examples) {
        const assetType = String(example.input['asset_type']);
        const args = { ...example.input, limit: 3 };
        let outcome: 'ok' | 'refused' = 'ok';
        let rows = 0;
        try {
          const r = (await rpc(build, 'tools/call', { name: 'query_assets', arguments: args })) as {
            isError?: boolean;
            structuredContent?: { items?: unknown[] };
          };
          if (r.isError === true) outcome = 'refused';
          else rows = r.structuredContent?.items?.length ?? 0;
        } catch {
          outcome = 'refused';
        }
        if (assetType === 'Test' || assetType === 'Defect')
          expect(outcome, `${recipe.id} / ${example.title}`).toBe('ok');
        if (outcome === 'ok') {
          tally.ok++;
          tally.rows += rows;
        } else tally.absentOrRefused++;
      }
    }
    console.info(
      `quality recipes live: ok=${tally.ok} rows=${tally.rows} absentOrRefused=${tally.absentOrRefused}`,
    );
  });
});
