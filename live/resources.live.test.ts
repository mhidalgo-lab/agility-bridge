// SPDX-License-Identifier: Apache-2.0
// P6-09 live suite: the upstream-reading resources against the read-only tenant. Every request goes through guardedFetch
// (the P0-12 guard); the suite asserts on counts and shapes only and prints nothing from the tenant: no names, ids,
// URLs or custom attribute names. A few dozen read requests, one at a time.
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

describe.skipIf(!target)('MCP resources against the live tenant (read-only)', () => {
  it('lists and reads every resource: enveloped text, counts only', { timeout: 180_000 }, async () => {
    const metadata = new MetadataService();
    const build = () => buildMcpServer({ tools: CORE_TOOLS, ctx: () => liveContext(metadata) });
    const listed = (await rpc(build, 'resources/list')) as { resources: Array<{ uri: string }> };
    const uris = listed.resources.map((r) => r.uri);
    expect(uris.length).toBeGreaterThanOrEqual(5);
    // One per-type URI is read live; the rest of the types are read in the offline suite.
    const perType = uris.filter((u) => u.startsWith('agility-bridge://instance/asset-types/')).slice(0, 3);
    const sample = [
      ...uris.filter((u) => !u.startsWith('agility-bridge://instance/asset-types/')),
      ...perType,
    ];
    let enveloped = 0;
    for (const uri of sample) {
      const r = (await rpc(build, 'resources/read', { uri })) as { contents: Array<{ text: string }> };
      const text = r.contents[0]?.text ?? '';
      expect(text.length).toBeGreaterThan(20);
      if (text.includes('<untrusted-data')) enveloped++;
    }
    // The tool-backed resources (types, per-type, projects) carry instance strings, so each of them is enveloped.
    expect(enveloped).toBeGreaterThanOrEqual(2);
  });
});
