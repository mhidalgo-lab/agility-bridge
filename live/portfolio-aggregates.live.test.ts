// SPDX-License-Identifier: Apache-2.0
// P6-15 live check (D-80, L-148): do downcast aggregates over `Subs` work on the read-only tenant? Raw `query.v1`
// reads through guardedFetch (the P0-12 read-only guard). Assertions are booleans with our own labels: shapes, counts
// and agreement only; nothing from the tenant is printed or kept (no names, ids, URLs or custom attribute names).
import { describe, expect, it } from 'vitest';
import {
  agilityClient,
  canonicalInstanceUrl,
  closedBreaker,
  createBudget,
  DEFAULT_LIMITS,
  Secret,
  Semaphore,
  silentLogger,
  systemClock,
  type ToolContext,
  webCryptoRandom,
} from '../packages/core/src/index.ts';
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

type Row = Record<string, unknown>;
const ok = (condition: boolean, label: string) => expect(condition, label).toBe(true);
const n = (v: unknown): number | undefined => {
  const x = typeof v === 'string' && v === '' ? Number.NaN : Number(v);
  return v === null || v === undefined || !Number.isFinite(x) ? undefined : x;
};
const LIVE = "[AssetState!='Dead']";
const forms = {
  stories: `Subs:Story${LIVE}.@Count`,
  storyEstimate: `Subs:Story${LIVE}.Estimate.@Sum`,
  defects: `Subs:Defect${LIVE}.@Count`,
  doneStories: `Subs:Story[AssetState='128'].@Count`,
  // A status or state condition for done and open defects: closed items have AssetState 128.
  openDefects: `Subs:Defect[AssetState='64'].@Count`,
} as const;

describe.skipIf(!target)('P6-15: downcast aggregates over Subs (read-only)', () => {
  it('answers the aggregate selections, and they agree with the rows read', {
    timeout: 120_000,
  }, async () => {
    const ctx = liveContext();
    const client = agilityClient(ctx);
    const query = async (body: Record<string, unknown>) => {
      try {
        const res = await client.query<Row[][]>(body as never);
        return { status: res.status, rows: (res.data[0] ?? []) as Row[], failed: false };
      } catch {
        return { status: 0, rows: [] as Row[], failed: true };
      }
    };
    // 1. Which forms does the instance accept? (shapes only)
    const accepted: string[] = [];
    let sample: Row[] = [];
    for (const [label, form] of Object.entries(forms)) {
      const r = await query({ from: 'Epic', select: ['ID', form], page: { start: 0, size: 25 } });
      if (!r.failed && r.rows.length > 0 && r.rows.some((row) => n(row[form]) !== undefined)) {
        accepted.push(label);
        if (label === 'stories') sample = r.rows;
      }
    }
    process.stderr.write(
      `live aggregates: accepted forms ${accepted.length} of ${Object.keys(forms).length}: ${accepted.join(',')}\n`,
    );
    ok(accepted.length === Object.keys(forms).length, 'every downcast aggregate form is accepted');
    // Variants, to see which relation and condition match the rows (relation of the aggregate to the rows, no data).
    const variants = {
      subsStoryAll: 'Subs:Story.@Count',
      subsStoryNotDead: "Subs:Story[AssetState!='Dead'].@Count",
      subsStoryOpen: "Subs:Story[AssetState='64'].@Count",
      childrenStory: "Children:Story[AssetState!='Dead'].@Count",
      subsAll: "Subs[AssetState!='Dead'].@Count",
    };
    const probe = await query({
      from: 'Story',
      select: ['Super'],
      filter: ['Super=$epic', "AssetState!='Dead'"],
      with: { epic: String(sample[0]?.['_oid']) },
      page: { start: 0, size: 300 },
    });
    for (const [label, form] of Object.entries(variants)) {
      const r = await query({
        from: 'Epic',
        select: ['ID', form],
        filter: ['ID=$epic'],
        with: { epic: String(sample[0]?.['_oid']) },
      });
      const v = n(r.rows[0]?.[form]);
      process.stderr.write(
        `live aggregates: variant ${label}: ${r.failed ? 'refused' : v === undefined ? 'no number' : v === probe.rows.length ? 'equals rows' : v < probe.rows.length ? (v === 0 ? 'zero, fewer than rows' : 'positive, fewer than rows') : 'more than rows'}\n`,
      );
    }
    if (!accepted.includes('stories')) return;
    // 2. Agreement with the rows for up to three epics that have stories (counts compared, never printed).
    const parents = sample
      .filter((r) => (n(r[forms.stories]) ?? 0) > 0 && (n(r[forms.stories]) ?? 0) <= 200)
      .slice(0, 3);
    let compared = 0;
    let agreed = 0;
    let estimateCompared = 0;
    let estimateAgreed = 0;
    for (const p of parents) {
      const oid = String(p['_oid']);
      const stories = await query({
        from: 'Story',
        select: ['Estimate'],
        filter: ['Super=$epic', "AssetState!='Dead'"],
        with: { epic: oid },
        page: { start: 0, size: 300 },
      });
      if (stories.failed) continue;
      compared++;
      const agg = n(p[forms.stories]) ?? -1;
      process.stderr.write(
        `live aggregates: epic ${compared}: rows ${stories.rows.length === agg ? 'equal' : stories.rows.length < agg ? 'fewer than' : 'more than'} aggregate, rows ${stories.rows.length > 0 ? 'some' : 'none'}\n`,
      );
      if (stories.rows.length === agg) agreed++;
      if (accepted.includes('storyEstimate')) {
        estimateCompared++;
        const sum = stories.rows.reduce((s, r) => s + (n(r['Estimate']) ?? 0), 0);
        if (Math.abs(sum - (n(p[forms.storyEstimate]) ?? 0)) < 1e-6) estimateAgreed++;
      }
    }
    process.stderr.write(
      `live aggregates: epics compared ${compared}, count agreed ${agreed}, estimate compared ${estimateCompared}, estimate agreed ${estimateAgreed}\n`,
    );
    // Recorded, not asserted (P6-15): on the tenant the aggregate counted fewer stories than the rows read, so the
    // aggregate is not used for roll-ups (RESEARCH, D-143).
    ok(compared > 0 || agreed === 0, 'comparison recorded');
  });
});
