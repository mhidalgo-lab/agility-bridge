// SPDX-License-Identifier: Apache-2.0
// P6-02 live check: get_sprint against the read-only tenant. Every request goes through guardedFetch (P0-12); the test
// asserts on shapes, counts and invariants only, prints nothing from the tenant, and writes coarse levels to the
// git-ignored live/results/. Sprints are picked through list_sprints and addressed by OID, one request at a time
// (about 40 read requests in all).
import { mkdirSync, writeFileSync } from 'node:fs';
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
  type ToolDefinition,
  webCryptoRandom,
} from '../packages/core/src/index.ts';
import { getSprint } from '../packages/core/src/tools/planning/sprint.ts';
import { rpc } from '../packages/core/test/helpers/mcp.ts';
import { liveTarget } from './env.ts';
import { guardedFetch } from './guarded-fetch.ts';
import { shape } from './shape.ts';

const target = liveTarget();

function liveContext(metadata: MetadataService): ToolContext {
  if (target === undefined) throw new Error('no live target');
  return {
    requestId: crypto.randomUUID(),
    instance: { id: 'live', baseUrl: canonicalInstanceUrl(target.baseUrl) },
    workspace: {
      id: 'live',
      name: 'Live',
      groups: ['planning'],
      writes: { enabled: false, approval: 'unavailable' },
    },
    credential: { id: 'live', kind: 'personal', token: new Secret(target.token) },
    projects: { allowed: [], includeChildren: true },
    assetTypes: { deny: [] },
    limits: DEFAULT_LIMITS,
    budget: createBudget(40),
    limiter: new Semaphore(1),
    breaker: closedBreaker,
    fetch: guardedFetch(target),
    logger: silentLogger,
    clock: systemClock,
    random: webCryptoRandom,
    metadata,
  };
}

const level = (n: number): string => (n === 0 ? 'none' : n < 10 ? 'few' : n < 100 ? 'some' : '100+');

type Out = Record<string, unknown>;
const structured = (r: Record<string, unknown>): Out => r['structuredContent'] as Out;
const textOf = (r: Record<string, unknown>): string =>
  String((r['content'] as Array<{ text: string }>)[0]?.text);

describe.skipIf(!target)('get_sprint against the live tenant (read-only)', () => {
  it('reports a past and a current sprint with bounded history and honest notes', {
    timeout: 300_000,
  }, async () => {
    const metadata = new MetadataService();
    const call = (tool: ToolDefinition, args: Record<string, unknown>) =>
      rpc(() => buildMcpServer({ tools: [tool], ctx: liveContext(metadata) }), 'tools/call', {
        name: tool.name,
        arguments: args,
      });
    const report: Record<string, unknown> = {};
    // Sprints that have items: the recently changed backlog items name theirs (one read request).
    const probe = agilityClient(liveContext(metadata));
    const recent = await probe.query<Array<Array<Record<string, unknown>>>>({
      from: 'Story',
      select: ['Timebox', 'Timebox.BeginDate', 'Timebox.EndDate'],
      filter: ['Timebox!=""'],
      sort: ['-ChangeDate'],
      page: { start: 0, size: 60 },
    });
    const ended = await probe.query<Array<Array<Record<string, unknown>>>>({
      from: 'Story',
      select: ['Timebox', 'Timebox.BeginDate', 'Timebox.EndDate'],
      filter: [`Timebox.EndDate<'${new Date().toISOString()}'`],
      sort: ['-ChangeDate'],
      page: { start: 0, size: 60 },
    });
    const utc = (v: unknown) => Date.parse(`${String(v).replace(/Z$/, '')}Z`);
    const pick = (timing: 'past' | 'current'): { oid: string } | undefined => {
      for (const row of [...(recent.data[0] ?? []), ...(ended.data[0] ?? [])]) {
        const t = row['Timebox'] as { _oid?: string } | string | undefined;
        const oid = (typeof t === 'string' ? t : t?._oid)?.split(':').slice(0, 2).join(':');
        const begin = utc(row['Timebox.BeginDate']);
        const end = utc(row['Timebox.EndDate']);
        const now = Date.now();
        const kind = end <= now ? 'past' : begin > now ? 'future' : 'current';
        if (oid !== undefined && kind === timing) return { oid };
      }
      return undefined;
    };
    for (const timing of ['past', 'current'] as const) {
      const first = pick(timing);
      if (first === undefined) {
        report[timing] = 'no recently changed item in a sprint of this kind';
        continue;
      }
      const r = await call(getSprint, { sprint: first.oid });
      // The message of a failure is tenant content: only its code reaches the log.
      expect(r['isError'], textOf(r).slice(0, 14)).toBeUndefined();
      const out = structured(r);
      const sprint = out['sprint'] as Record<string, unknown>;
      expect(sprint['timing']).toBe(timing);
      expect(typeof sprint['beginDate']).toBe('string');
      const totals = out['totals'] as Record<string, number>;
      expect(Number.isInteger(totals['items'])).toBe(true);
      // The categories add up to the items counted, and nothing is null.
      const categories = out['byStatusCategory'] as Array<{ items: number }>;
      expect(categories.reduce((n, c) => n + c.items, 0)).toBe(totals['items']);
      expect(JSON.stringify(out)).not.toContain(':null');
      // History is bounded: at most 15 points, ordered, never after now, and the last point reconciles with the totals.
      const points = (out['burndown'] as Array<{ at: string; remaining?: number }> | undefined) ?? [];
      expect(points.length).toBeLessThanOrEqual(15);
      expect(points.every((p, i) => i === 0 || (points[i - 1] as { at: string }).at < p.at)).toBe(true);
      expect(points.every((p) => Date.parse(p.at) <= Date.now())).toBe(true);
      if (points.length > 0 && totals['remaining'] !== undefined)
        expect((points.at(-1) as { remaining?: number }).remaining).toBe(totals['remaining']);
      expect(textOf(r)).toContain('untrusted-data');
      expect(Array.isArray(out['notes'])).toBe(true);
      const meta = r['_meta'] as Record<string, Record<string, unknown>> | undefined;
      report[timing] = {
        items: level(totals['items'] as number),
        categories: categories.length,
        burndownPoints: points.length,
        committed: out['committed'] !== undefined,
        carryOver: out['carryOver'] !== undefined,
        partial: out['partial'] === true,
        // Notes are our own sentences (never Agility text); digits are masked.
        noteKinds: (out['notes'] as string[]).map((n) => n.replace(/\d+/g, 'N').slice(0, 70)),
        requestsUsed: meta?.['agility-bridge/result']?.['requestsUsed'],
        shape: shape({ ...out, items: (out['items'] as unknown[]).slice(0, 1) }),
      };
    }
    mkdirSync('live/results', { recursive: true });
    writeFileSync('live/results/sprint.json', `${JSON.stringify(report, null, 2)}\n`);
  });
});
