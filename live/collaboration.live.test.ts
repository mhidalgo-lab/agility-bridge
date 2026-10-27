// SPDX-License-Identifier: Apache-2.0
// P6-04 live suite: conversations and attachment metadata against the read-only tenant. The guard (P0-12) allows no
// attachment content request (`attachments.img`), so the download itself is verified on fixtures only; here
// `get_attachment` is checked up to the point where it would fetch content (scope and metadata checks, with every
// content type refused, so nothing is requested). Assertions are on counts and shapes; nothing from the tenant is printed.
import { describe, expect, it } from 'vitest';
import {
  agilityClient,
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
import { metadataFor } from '../packages/core/src/metadata/service.ts';
import { getAttachment, listAttachments } from '../packages/core/src/tools/collaboration/attachments.ts';
import { getConversations } from '../packages/core/src/tools/collaboration/conversations.ts';
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
      groups: ['core', 'collaboration'],
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
const code = (r: Record<string, unknown>) =>
  (r['_meta'] as Record<string, { code?: string }> | undefined)?.['agility-bridge/error']?.code;

describe.skipIf(!target)('collaboration tools against the live tenant (read-only)', () => {
  it('has the product attributes the tools read (counts only)', async () => {
    const ctx = liveContext();
    const md = metadataFor(ctx);
    const want: Record<string, string[]> = {
      Expression: ['Author', 'AuthoredAt', 'Content', 'BelongsTo', 'Mentions'],
      Attachment: ['Name', 'Filename', 'ContentType', 'Asset'],
      Link: ['Name', 'URL', 'Asset'],
    };
    for (const [type, names] of Object.entries(want)) {
      const meta = await md.assetType(type);
      const missing = names.filter((n) => !meta.attributes.has(n));
      expect(missing, type).toEqual([]);
    }
    // Optional product attributes: only how many of them exist is recorded.
    const optional = ['ContentLength', 'Description', 'CreateDateUTC', 'CreateDate', 'CreatedBy'];
    const meta = await md.assetType('Attachment');
    const present = optional.filter((n) => meta.attributes.has(n));
    expect(present.length).toBeGreaterThan(0);
  });

  it('get_conversations and list_attachments answer on real assets, shapes only', {
    timeout: 120_000,
  }, async () => {
    const ctx = liveContext();
    const withAttachment = (
      await agilityClient(ctx).query<Rows>({
        from: 'Attachment',
        select: ['Asset'],
        sort: ['-ID'],
        page: { start: 0, size: 5 },
      })
    ).data[0];
    const attached = (withAttachment ?? [])
      .map((r) => oidOf(r['Asset']))
      .find((o) => o !== undefined && /^(Story|Defect|Task|Test|Epic|Issue|Request):\d+$/.test(o));
    const commented = (
      await agilityClient(ctx).query<Rows>({
        from: 'Expression',
        select: ['Mentions'],
        sort: ['-ID'],
        page: { start: 0, size: 10 },
      })
    ).data[0];
    const discussed = (commented ?? [])
      .map((r) => oidOf(r['Mentions']))
      .find((o) => o !== undefined && /^(Story|Defect|Task|Test|Epic|Issue|Request):\d+$/.test(o));
    expect(attached ?? discussed, 'the tenant has attachments or comments on work items').toBeDefined();

    if (discussed !== undefined) {
      const fresh = liveContext();
      const r = await rpc(() => buildMcpServer({ tools: [getConversations], ctx: fresh }), 'tools/call', {
        name: 'get_conversations',
        arguments: { asset: discussed, limit: 3 },
      });
      expect(code(r)).toBeUndefined();
      expect(r['isError']).toBeUndefined();
      const items = (r['structuredContent'] as { items: unknown[] }).items;
      expect(items.length).toBeGreaterThan(0);
      expect(items.length).toBeLessThanOrEqual(3);
      expect(fresh.budget.used).toBeLessThanOrEqual(getConversations.cost);
    }

    if (attached !== undefined) {
      const fresh = liveContext();
      const r = await rpc(() => buildMcpServer({ tools: [listAttachments], ctx: fresh }), 'tools/call', {
        name: 'list_attachments',
        arguments: { asset: attached, limit: 3 },
      });
      expect(code(r)).toBeUndefined();
      expect(r['isError']).toBeUndefined();
      const structured = r['structuredContent'] as {
        items: Array<Record<string, unknown>>;
        links?: unknown[];
      };
      expect(structured.items.length).toBeGreaterThan(0);
      expect(Array.isArray(structured.links)).toBe(true);
      expect(fresh.budget.used).toBeLessThanOrEqual(listAttachments.cost);

      // get_attachment: scope and metadata verified against the tenant; every content type is refused, so the
      // content request (which the guard would refuse) is never made.
      const oid = structured.items[0]?.['oid'];
      const strict = liveContext({
        limits: { ...DEFAULT_LIMITS, attachmentDownload: true, attachmentTypes: ['text/x-none'] },
      });
      const g = await rpc(() => buildMcpServer({ tools: [getAttachment], ctx: strict }), 'tools/call', {
        name: 'get_attachment',
        arguments: { asset: attached, attachment: oid },
      });
      expect(g['isError']).toBe(true);
      expect(code(g)).toBe('AB_INPUT_INVALID');
      const off = await rpc(
        () => buildMcpServer({ tools: [getAttachment], ctx: liveContext() }),
        'tools/call',
        { name: 'get_attachment', arguments: { asset: attached, attachment: oid } },
      );
      expect(code(off)).toBe('AB_TOOL_DISABLED');
    }
  });
});
