// SPDX-License-Identifier: Apache-2.0
// P9-24 live suite: an image pasted into a defect's description, fetched by get_embedded_image in a workspace restricted
// to that defect's project, and (P9-27) an image attached to a recent comment. The guard allows GET of one image
// (embedded.img/<id>, downloadblob.img/<token>, expressionimage.img/<id>) and nothing else new. Assertions are on shapes (type, byte count, block kinds); nothing from the tenant is printed.
import { describe, expect, it } from 'vitest';
import {
  agilityClient,
  buildMcpServer,
  canonicalInstanceUrl,
  closedBreaker,
  createBudget,
  DEFAULT_LIMITS,
  imageSources,
  MetadataService,
  Secret,
  Semaphore,
  silentLogger,
  systemClock,
  type ToolContext,
  webCryptoRandom,
} from '../packages/core/src/index.ts';
import { getConversations } from '../packages/core/src/tools/collaboration/conversations.ts';
import { classifyImageSource, getEmbeddedImage } from '../packages/core/src/tools/collaboration/images.ts';
import { rpc } from '../packages/core/test/helpers/mcp.ts';
import { liveTarget } from './env.ts';
import { guardedFetch } from './guarded-fetch.ts';

const target = liveTarget();

function liveContext(over: Partial<ToolContext> = {}): ToolContext {
  if (target === undefined) throw new Error('no live target');
  return {
    requestId: crypto.randomUUID(),
    instance: { id: 'live', baseUrl: canonicalInstanceUrl(target.baseUrl) },
    workspace: {
      id: 'live',
      name: 'Live',
      groups: ['core', 'images'],
      writes: { enabled: false, approval: 'unavailable' },
    },
    credential: { id: 'live', kind: 'personal', token: new Secret(target.token) },
    projects: { allowed: [], includeChildren: true },
    assetTypes: { deny: [] },
    limits: { ...DEFAULT_LIMITS, imageDownload: true },
    budget: createBudget(60),
    limiter: new Semaphore(1),
    breaker: closedBreaker,
    fetch: guardedFetch(target),
    metadata: new MetadataService(),
    logger: silentLogger,
    clock: systemClock,
    random: webCryptoRandom,
    ...over,
  };
}

type Rows = Array<Array<Record<string, unknown>>>;
const oidOf = (v: unknown): string | undefined => {
  const o = Array.isArray(v) ? v[0] : v;
  const s = typeof o === 'string' ? o : (o as { _oid?: string } | undefined)?._oid;
  return s?.split(':').slice(0, 2).join(':');
};

describe.skipIf(!target)('get_embedded_image against the live tenant (read-only)', () => {
  it('returns a pasted image of a recent defect as an image block, in a workspace of its one project', {
    timeout: 120_000,
  }, async () => {
    const ctx = liveContext();
    const recent = (
      await agilityClient(ctx).query<Rows>({
        from: 'Defect',
        select: ['Number', 'Scope', 'Description'],
        sort: ['-ID'],
        page: { start: 0, size: 100 },
      })
    ).data[0];
    // A defect whose first image is on one of the instance's own image endpoints and small enough to return.
    const found = (recent ?? [])
      .map((r) => ({ r, first: imageSources(String(r['Description'] ?? ''))[0] }))
      .find(
        ({ first }) =>
          first !== undefined && classifyImageSource(first, ctx.instance.baseUrl).kind !== 'refused',
      );
    expect(found, 'one of the latest 100 defects has a pasted image').toBeDefined();
    if (found === undefined) return;
    const scope = oidOf(found.r['Scope']) as string;
    const restricted = liveContext({
      projects: { allowed: [scope], includeChildren: false },
      limits: { ...DEFAULT_LIMITS, imageDownload: true, imageMaxBytes: 8 * 1024 * 1024 },
    });
    const r = await rpc(() => buildMcpServer({ tools: [getEmbeddedImage], ctx: restricted }), 'tools/call', {
      name: 'get_embedded_image',
      arguments: { asset: found.r['Number'], image: 1 },
    });
    const blocks = r['content'] as Array<{ type: string; mimeType?: string; data?: string }>;
    if (r['isError'] === true) {
      // Only a size refusal is acceptable (a large screenshot against the 512 KiB response cap); shapes only.
      const code = (r['_meta'] as Record<string, { code?: string }>)['agility-bridge/error']?.code;
      expect(code).toBe('AB_LIMIT_RESPONSE_TOO_LARGE');
      return;
    }
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image']);
    expect(['image/png', 'image/jpeg', 'image/gif', 'image/webp']).toContain(blocks[1]?.mimeType);
    expect((blocks[1]?.data ?? '').length).toBeGreaterThan(100);
    expect(restricted.budget.used).toBeLessThanOrEqual(getEmbeddedImage.cost);
  });
});

describe.skipIf(!target)('comment images against the live tenant (read-only, P9-27)', () => {
  it('lists and returns an image attached to a recent comment, in a workspace of its one project', {
    timeout: 120_000,
  }, async () => {
    const ctx = liveContext();
    const recent = (
      await agilityClient(ctx).query<Rows>({
        from: 'Expression',
        select: ['Mentions:Workitem.Number', 'Mentions:Workitem.Scope', 'ExpressionImages.@Count'],
        filter: ['ExpressionImages.@Count>"0"', 'Mentions:Workitem.@Count>"0"'],
        sort: ['-AuthoredAt'],
        page: { start: 0, size: 20 },
      })
    ).data[0];
    const found = (recent ?? []).find((r) => {
      const n = r['Mentions:Workitem.Number'];
      return Array.isArray(n) && n.length === 1;
    });
    expect(found, 'one of the latest comments with images mentions one work item').toBeDefined();
    if (found === undefined) return;
    const number = (found['Mentions:Workitem.Number'] as string[])[0] as string;
    const comment = oidOf(found['_oid']) as string;
    const scope = oidOf(found['Mentions:Workitem.Scope']) as string;
    const restricted = () =>
      liveContext({
        projects: { allowed: [scope], includeChildren: false },
        limits: { ...DEFAULT_LIMITS, imageDownload: true, imageMaxBytes: 8 * 1024 * 1024 },
      });
    const listCtx = restricted();
    const listed = await rpc(
      () => buildMcpServer({ tools: [getConversations], ctx: listCtx }),
      'tools/call',
      {
        name: 'get_conversations',
        arguments: { asset: number, format: 'json', limit: 50 },
      },
    );
    expect(listed['isError']).toBeUndefined();
    const items = (listed['structuredContent'] as { items: Array<Record<string, unknown>> }).items;
    const shown = items.find((i) => i['oid'] === comment);
    if (shown !== undefined) expect(String(shown['images'])).toMatch(/^\[image 1/);
    const imageCtx = restricted();
    const r = await rpc(() => buildMcpServer({ tools: [getEmbeddedImage], ctx: imageCtx }), 'tools/call', {
      name: 'get_embedded_image',
      arguments: { asset: number, field: 'comment', comment, image: 1 },
    });
    if (r['isError'] === true) {
      const code = (r['_meta'] as Record<string, { code?: string }>)['agility-bridge/error']?.code;
      expect(code).toBe('AB_LIMIT_RESPONSE_TOO_LARGE');
      return;
    }
    const blocks = r['content'] as Array<{ type: string; mimeType?: string; data?: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image']);
    expect(['image/png', 'image/jpeg', 'image/gif', 'image/webp']).toContain(blocks[1]?.mimeType);
    expect((blocks[1]?.data ?? '').length).toBeGreaterThan(100);
    expect(imageCtx.budget.used).toBeLessThanOrEqual(getEmbeddedImage.cost);
  });
});
