// SPDX-License-Identifier: Apache-2.0
// P6-02 get_sprint: committed vs done, status categories, carry-over, scope change and a burndown from bounded history.
// The synthetic world: Sprint 41 (past, with a carry-over), Sprint 42 (running), Sprint 43 (future), a long past sprint
// and a sprint of another Agility project. History is point-in-time snapshots of the work items (`asof`).
import { describe, expect, it } from 'vitest';
import {
  buildMcpServer,
  createBudget,
  DEFAULT_LIMITS,
  MetadataService,
  type ToolContext,
} from '../../src/index.ts';
import { getSprint } from '../../src/tools/planning/sprint.ts';
import snapshotJson from '../fixtures/agility/meta-snapshot.json' with { type: 'json' };
import {
  FakeAgility,
  type FakeAgilityOptions,
  type FakeCall,
  makeContext,
  measureCost,
  poison,
  probeTool,
  type Row,
} from '../harness/index.ts';
import { rpc } from '../helpers/mcp.ts';

const SNAPSHOT = snapshotJson as unknown as Record<string, unknown>;
const NOW = Date.parse('2026-10-21T12:00:00Z');

const item = (
  id: number,
  type: 'Story' | 'Defect',
  sprint: number,
  status: number | undefined,
  estimate: number | undefined,
  extra: Row = {},
): Row => ({
  _oid: `${type}:${id}`,
  AssetType: type,
  Number: `${type === 'Story' ? 'B' : 'D'}-${String(id).padStart(5, '0')}`,
  Name: `Synthetic item ${id}`,
  AssetState: status === 3 ? 128 : 64,
  Scope: 'Scope:1001',
  Timebox: `Timebox:${sprint}`,
  Status: status === undefined ? null : `StoryStatus:${status}`,
  'Status.Name': status === undefined ? null : ['', 'Not started', 'In progress', 'Done'][status],
  Estimate: estimate ?? null,
  ...extra,
});

function snapshots(p: (n: number, plain: string) => string) {
  const s11 = (status: number) => item(11, 'Story', 41, status, 5);
  const s12 = (sprint: number) => item(12, 'Story', sprint, 2, 3);
  return [
    { at: '2026-09-30T00:00:00Z', rows: [s11(2), s12(41), item(13, 'Story', 41, 1, 2)] },
    {
      at: '2026-10-05T00:00:00Z',
      rows: [s11(3), s12(41), item(13, 'Story', 41, 1, 2), item(14, 'Story', 41, 2, 4)],
    },
    {
      at: '2026-10-10T00:00:00Z',
      rows: [
        s11(3),
        s12(41),
        item(13, 'Story', 40, 1, 2),
        item(14, 'Story', 41, 2, 4),
        item(1, 'Story', 42, 2, 5),
        item(2, 'Story', 42, 2, 3, { Name: p(5, 'Synthetic item 2') }),
        item(3, 'Defect', 42, 1, undefined),
      ],
    },
    {
      at: '2026-10-15T06:00:00Z',
      rows: [
        s11(3),
        s12(42),
        item(14, 'Story', 41, 2, 4),
        item(1, 'Story', 42, 2, 5),
        item(2, 'Story', 42, 2, 3),
        item(3, 'Defect', 42, 1, undefined),
      ],
    },
    {
      at: '2026-10-18T00:00:00Z',
      rows: [
        s11(3),
        s12(42),
        item(14, 'Story', 41, 2, 4),
        item(1, 'Story', 42, 3, 5),
        item(2, 'Story', 42, 2, 3),
        item(3, 'Defect', 42, 1, undefined),
        item(4, 'Story', 42, 2, 8),
        item(21, 'Story', 43, 1, 2),
      ],
    },
  ];
}

const sprint = (
  id: number,
  name: string,
  begin: string,
  end: string,
  schedule = 'Schedule:1',
  state = 64,
) => ({
  _oid: `Timebox:${id}`,
  Name: name,
  BeginDate: begin,
  EndDate: end,
  AssetState: state,
  Schedule: schedule,
  'Schedule.Name': `Synthetic ${schedule}`,
  'Schedule.ScheduledScopes': schedule === 'Schedule:1' ? ['Scope:1001'] : ['Scope:2000'],
});

function world(
  poisoned = false,
  statuses?: Row[],
  history = snapshots,
): Pick<FakeAgilityOptions, 'assets' | 'history'> {
  const p = (n: number, plain: string) => (poisoned ? poison(n) : plain);
  const hist = history(p);
  const latest = hist[hist.length - 1]?.rows ?? [];
  return {
    history: { PrimaryWorkitem: hist },
    assets: {
      PrimaryWorkitem: [...latest, { ...item(9, 'Story', 42, 2, 1), Scope: 'Scope:2000' }],
      StoryStatus: statuses ?? [
        { _oid: 'StoryStatus:1', Name: p(1, 'Not started'), Order: 1, RollupState: 0 },
        { _oid: 'StoryStatus:2', Name: 'In progress', Order: 2, RollupState: 64 },
        { _oid: 'StoryStatus:3', Name: p(2, 'Done'), Order: 3, RollupState: 128 },
      ],
      Timebox: [
        sprint(41, 'Sprint 41', '2026-10-01T00:00:00Z', '2026-10-15T00:00:00Z', 'Schedule:1', 128),
        sprint(42, p(3, 'Sprint 42'), '2026-10-15T00:00:00Z', '2026-10-29T00:00:00Z'),
        sprint(43, 'Sprint 43', '2026-10-29T00:00:00Z', '2026-11-12T00:00:00Z'),
        sprint(44, 'Long sprint', '2026-08-01T00:00:00Z', '2026-10-01T00:00:00Z', 'Schedule:1', 128),
        sprint(99, 'Elsewhere', '2026-10-15T00:00:00Z', '2026-10-29T00:00:00Z', 'Schedule:9'),
      ],
      Team: [{ _oid: 'Team:5', Name: 'Blue', AssetState: 64 }],
      Scope: [
        { _oid: 'Scope:1001', Name: 'Mobile App', AssetState: 64, ChildrenMeAndDown: ['Scope:1001'] },
        { _oid: 'Scope:2000', Name: 'Outside', AssetState: 64, ChildrenMeAndDown: ['Scope:2000'] },
      ],
    },
  };
}

function setup(options: Partial<FakeAgilityOptions> = {}, poisoned = false) {
  const fake = new FakeAgility({ meta: SNAPSHOT, ...world(poisoned), ...options });
  const ctx = (o: Partial<ToolContext> = {}) =>
    makeContext({
      fetch: fake.fetch,
      metadata: new MetadataService(),
      budget: createBudget(100),
      projects: { allowed: ['Scope:1001'], includeChildren: true },
      clock: { now: () => NOW },
      ...o,
    });
  return { fake, ctx };
}

const call = (ctx: ToolContext, args: Record<string, unknown> = {}) =>
  rpc(() => buildMcpServer({ tools: [getSprint], ctx }), 'tools/call', {
    name: 'get_sprint',
    arguments: args,
  });
const text = (r: Record<string, unknown>) => (r['content'] as Array<{ text: string }>)[0]?.text ?? '';
// biome-ignore lint/suspicious/noExplicitAny: structured output is asserted field by field.
type Out = Record<string, any>;
const s = (r: Record<string, unknown>) => r['structuredContent'] as Out;
const asofCalls = (calls: readonly FakeCall[]) =>
  calls.filter(
    (c) =>
      c.path === 'query.v1' &&
      (Array.isArray(c.body) ? c.body : [c.body]).some((b) => (b as { asof?: string }).asof !== undefined),
  );

describe('a closed item with no status category (P6-13)', () => {
  it('counts as done now, and the burndown says that earlier points cannot know it', async () => {
    // A closed story without a status: only its AssetState says it is done. History points do not read the state.
    const closed = () => item(30, 'Story', 42, undefined, 4, { AssetState: 128 });
    const hist = (p: (n: number, plain: string) => string) =>
      snapshots(p).map((snap) => ({ ...snap, rows: [...snap.rows, closed()] }));
    const { ctx } = setup(world(false, undefined, hist));
    const r = await call(ctx(), { sprint: 'Sprint 42' });
    expect(r['isError'], text(r)).toBeUndefined();
    expect(s(r)['totals']).toMatchObject({ done: 9 });
    expect(text(r)).toContain('1 closed item has no status category');
    // Without such an item there is no note.
    const plain = await call(setup().ctx(), { sprint: 'Sprint 42' });
    expect(text(plain)).not.toContain('no status category');
  });
});

describe('a running sprint', () => {
  it('reports totals by status category, committed vs done, scope change and the burndown', async () => {
    const { ctx } = setup();
    const r = await call(ctx(), { sprint: 'Sprint 42' });
    expect(r['isError'], text(r)).toBeUndefined();
    const out = s(r);
    expect(out['sprint']).toMatchObject({
      oid: 'Timebox:42',
      name: 'Sprint 42',
      timing: 'current',
      beginDate: '2026-10-15T00:00:00.000Z',
      endDate: '2026-10-29T00:00:00.000Z',
      schedule: { oid: 'Schedule:1' },
    });
    expect(out['basis']).toBe('now');
    // Now: B-1 done (5), B-2 in progress (3), D-3 not started (no estimate), B-12 in progress (3), B-4 in progress (8).
    expect(out['totals']).toEqual({
      itemCount: 5,
      estimate: 19,
      done: 5,
      remaining: 14,
      unestimatedItems: 1,
      unknownCategoryItems: 0,
    });
    expect(out['byStatusCategory']).toEqual([
      { category: 'not_started', itemCount: 1, unestimatedItems: 1 },
      { category: 'in_progress', itemCount: 3, estimate: 14, unestimatedItems: 0 },
      { category: 'completed', itemCount: 1, estimate: 5, unestimatedItems: 0 },
    ]);
    // Committed at the begin date: B-1, B-2 and D-3 were planned; B-12 and B-4 arrived later.
    expect(out['committed']).toEqual({
      itemCount: 3,
      estimate: 8,
      unestimatedItems: 1,
      at: '2026-10-15T00:00:00.000Z',
    });
    expect(out['scopeChange']).toEqual({ addedAfterStart: 2, removedSinceStart: 0 });
    expect(out['carryOver']).toBeUndefined();
    const points = out['burndown'] as Array<{ at: string; remaining?: number; ideal?: number }>;
    expect(points.map((x) => x.at.slice(0, 13))).toEqual([
      '2026-10-15T00',
      '2026-10-16T00',
      '2026-10-17T00',
      '2026-10-18T00',
      '2026-10-19T00',
      '2026-10-20T00',
      '2026-10-21T00',
      '2026-10-21T12',
    ]);
    expect(points.map((x) => x.remaining)).toEqual([8, 11, 11, 14, 14, 14, 14, 14]);
    // The last point is now and reconciles with the totals.
    expect(points.at(-1)?.remaining).toBe(out['totals'].remaining);
    expect(points[0]?.ideal).toBe(8);
    expect(points.every((x) => (x.ideal ?? 0) <= 8)).toBe(true);
    expect(out['notes']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('no estimate'),
        expect.stringContaining('Capacity is not reported'),
      ]),
    );
    expect(out['items']).toHaveLength(5);
    expect(JSON.stringify(r)).not.toContain('Scope:2000');
  });

  it('defaults to the current sprint and sends all history in one request, never into the future', async () => {
    const { ctx, fake } = setup();
    const r = await call(ctx());
    expect(s(r)['sprint']).toMatchObject({ oid: 'Timebox:42' });
    const history = asofCalls(fake.calls);
    expect(history).toHaveLength(1);
    const bodies = history[0]?.body as Array<{ asof: string }>;
    expect(bodies).toHaveLength(7);
    expect(bodies.every((b) => Date.parse(b.asof) < NOW)).toBe(true);
  });

  it('reads the first two pages of the sprint in one request (P6-41)', async () => {
    const { ctx, fake } = setup();
    const r = await call(ctx(), { burndown: false });
    expect(r['isError'], text(r)).toBeUndefined();
    const reads = fake.calls.filter(
      (c) =>
        c.path === 'query.v1' &&
        Array.isArray(c.body) &&
        (c.body as Array<{ from?: string }>).every((b) => b.from === 'PrimaryWorkitem'),
    );
    expect(reads).toHaveLength(1);
    const starts = ((reads[0]?.body ?? []) as Array<{ page: { start: number } }>).map((b) => b.page.start);
    expect(starts).toEqual([0, 100]);
    expect(s(r)['totals']).toMatchObject({ itemCount: 5 });
  });

  it('sends the history requests together, at most three at a time, within the L-279 bounds (P6-41)', async () => {
    let inFlight = 0;
    let peak = 0;
    const { ctx, fake } = setup({
      override: async (_req, c) => {
        const bodies = Array.isArray(c.body) ? c.body : [c.body];
        if (c.path !== 'query.v1' || !bodies.some((b) => (b as { asof?: string }).asof !== undefined))
          return undefined;
        peak = Math.max(peak, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
        return undefined;
      },
    });
    // 1000 rows per page: two queries per request, so the seven points need four requests.
    const r = await call(ctx({ limits: { ...DEFAULT_LIMITS, maxRows: 1000 } }), {});
    expect(r['isError'], text(r)).toBeUndefined();
    const history = asofCalls(fake.calls);
    expect(history).toHaveLength(4);
    expect(peak).toBe(3);
    const sizes = history.map((c) => (c.body as unknown[]).length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(20);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60);
    expect(s(r)['burndown']).toHaveLength(8);
  });

  it('skips history entirely with burndown false', async () => {
    const { ctx, fake } = setup();
    const out = s(await call(ctx(), { burndown: false }));
    expect(asofCalls(fake.calls)).toHaveLength(0);
    expect(out['burndown']).toBeUndefined();
    expect(out['committed']).toBeUndefined();
    expect(out['totals']).toMatchObject({ itemCount: 5 });
  });
});

describe('a finished sprint', () => {
  it('reads the sprint as it was at its end: carry-over, committed, scope change and a reconciling burndown', async () => {
    const { ctx, fake } = setup();
    const r = await call(ctx(), { sprint: 'Timebox:41' });
    expect(r['isError'], text(r)).toBeUndefined();
    const out = s(r);
    expect(out['sprint']).toMatchObject({ timing: 'past', state: 'closed' });
    expect(out['basis']).toBe('end_of_sprint');
    // At the end: B-11 done (5), B-12 in progress (3), B-14 in progress (4); B-13 had left, B-12 moved on afterwards.
    expect(out['totals']).toMatchObject({ itemCount: 3, estimate: 12, done: 5, remaining: 7 });
    expect(out['carryOver']).toEqual({ itemCount: 2, estimate: 7, unestimatedItems: 0 });
    expect(out['committed']).toMatchObject({ itemCount: 3, estimate: 10, at: '2026-10-01T00:00:00.000Z' });
    expect(out['scopeChange']).toEqual({ addedAfterStart: 1, removedSinceStart: 1 });
    const points = out['burndown'] as Array<{ at: string; remaining: number; ideal: number }>;
    expect(points).toHaveLength(15);
    expect(points[0]).toMatchObject({ at: '2026-10-01T00:00:00.000Z', remaining: 10, ideal: 10 });
    expect(points.map((x) => x.remaining)).toEqual([10, 10, 10, 10, 9, 9, 9, 9, 9, 7, 7, 7, 7, 7, 7]);
    // The last point (the end of the sprint) equals the remaining estimate of the totals; the ideal reaches 0.
    expect(points.at(-1)).toMatchObject({ at: '2026-10-15T00:00:00.000Z', remaining: 7, ideal: 0 });
    expect(points.at(-1)?.remaining).toBe(out['totals'].remaining);
    // Reads are bounded: pages 0 and 1 of the items at the end in one request, then one batched request for the 14 earlier points.
    expect(asofCalls(fake.calls).map((c) => (Array.isArray(c.body) ? c.body.length : 1))).toEqual([2, 14]);
  });

  it('widens the step so a long sprint never has more than 15 points', async () => {
    const { ctx, fake } = setup();
    const out = s(await call(ctx(), { sprint: 'Long sprint' }));
    expect((out['burndown'] as unknown[]).length).toBeLessThanOrEqual(15);
    expect(asofCalls(fake.calls).length).toBeLessThanOrEqual(2);
  });

  it('leaves out points beyond the history limit and says so', async () => {
    const { ctx } = setup();
    const r = await call(ctx({ limits: { ...DEFAULT_LIMITS, maxAsOfAgeDays: 10 } }), { sprint: 'Sprint 41' });
    expect(r['isError'], text(r)).toBeUndefined();
    const out = s(r);
    expect(out['partial']).toBe(true);
    expect(out['committed']).toBeUndefined();
    expect(out['scopeChange']).toBeUndefined();
    expect(out['notes']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('history limit'),
        expect.stringContaining('Committed is not reported'),
      ]),
    );
    expect(
      (out['burndown'] as Array<{ at: string }>).every((x) => Date.parse(x.at) >= NOW - 10 * 86_400_000),
    ).toBe(true);
  });

  it('shows items as they are now, without carry-over, when the sprint ended beyond the history limit', async () => {
    const { ctx } = setup();
    const out = s(
      await call(ctx({ limits: { ...DEFAULT_LIMITS, maxAsOfAgeDays: 3 } }), { sprint: 'Sprint 41' }),
    );
    expect(out['basis']).toBe('now');
    expect(out['carryOver']).toBeUndefined();
    expect(out['burndown']).toBeUndefined();
    expect(out['partial']).toBe(true);
  });
});

describe('a future sprint', () => {
  it('reports the plan, not a commitment, and reads no history', async () => {
    const { ctx, fake } = setup();
    const out = s(await call(ctx(), { sprint: 'next' }));
    expect(out['sprint']).toMatchObject({ oid: 'Timebox:43', timing: 'future' });
    expect(out['planned']).toMatchObject({ itemCount: 1, estimate: 2 });
    expect(out['committed']).toBeUndefined();
    expect(out['burndown']).toBeUndefined();
    expect(asofCalls(fake.calls)).toHaveLength(0);
    expect(out['notes']).toEqual(expect.arrayContaining([expect.stringContaining('has not started')]));
  });
});

describe('missing data is never turned into zeros (L-033)', () => {
  it('omits sums with no estimates and says how many items have none', async () => {
    const noEstimates = (p: (n: number, plain: string) => string) =>
      snapshots(p).map((snap) => ({
        ...snap,
        rows: snap.rows.map((r) => ({ ...r, Estimate: null })),
      }));
    const { ctx } = setup(world(false, undefined, noEstimates));
    const out = s(await call(ctx(), { sprint: 'Sprint 42' }));
    expect(out['totals']).toEqual({
      itemCount: 5,
      unestimatedItems: 5,
      unknownCategoryItems: 0,
    });
    expect(out['committed']).toEqual({ itemCount: 3, unestimatedItems: 3, at: '2026-10-15T00:00:00.000Z' });
    expect(
      (out['burndown'] as Array<Record<string, unknown>>).every((x) => x['remaining'] === undefined),
    ).toBe(true);
    expect(text(await call(ctx(), { sprint: 'Sprint 42' }))).toContain('no estimates');
  });

  it('counts items whose status has no category as unknown and says so', async () => {
    const { ctx } = setup(
      world(false, [
        { _oid: 'StoryStatus:1', Name: 'Not started', Order: 1 },
        { _oid: 'StoryStatus:2', Name: 'In progress', Order: 2 },
        { _oid: 'StoryStatus:3', Name: 'Done', Order: 3 },
      ]),
    );
    const out = s(await call(ctx(), { sprint: 'Sprint 42', burndown: false }));
    expect(out['totals']).toMatchObject({ unknownCategoryItems: 4, done: 5 });
    expect((out['byStatusCategory'] as Array<{ category: string }>).map((c) => c.category)).toEqual([
      'not_started',
      'in_progress',
      'completed',
      'unknown',
    ]);
    expect(out['notes']).toEqual(expect.arrayContaining([expect.stringContaining('no status category')]));
  });

  it('leaves out a history point it cannot read in full, and says so', async () => {
    // Ten items at the begin date, two now: the pages sized for the sprint today do not hold the past.
    const wide = (): ReturnType<typeof snapshots> => [
      {
        at: '2026-10-10T00:00:00Z',
        rows: Array.from({ length: 10 }, (_, i) => item(100 + i, 'Story', 42, 2, 1)),
      },
      { at: '2026-10-16T00:00:00Z', rows: [item(100, 'Story', 42, 2, 1), item(101, 'Story', 42, 3, 1)] },
    ];
    const { ctx } = setup(world(false, undefined, wide));
    const r = await call(ctx({ limits: { ...DEFAULT_LIMITS, maxRows: 2 } }), { sprint: 'Timebox:42' });
    expect(r['isError'], text(r)).toBeUndefined();
    const out = s(r);
    expect(out['partial']).toBe(true);
    expect(out['totals']).toMatchObject({ itemCount: 2 });
    expect(out['committed']).toBeUndefined();
    expect(out['notes']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('left out: the sprint had more than 4 items'),
        expect.stringContaining('Committed is not reported'),
      ]),
    );
    // The points that were read still reconcile with the totals at the end.
    const points = out['burndown'] as Array<{ remaining?: number }>;
    expect(points.at(-1)?.remaining).toBe(out['totals'].remaining);
  });

  it('leaves out the points of a chunk over the response cap and keeps the others (P6-42)', async () => {
    let asofRequests = 0;
    const { ctx, fake } = setup({
      override: (_req, c) => {
        const bodies = Array.isArray(c.body) ? c.body : [c.body];
        if (c.path !== 'query.v1' || !bodies.some((b) => (b as { asof?: string }).asof !== undefined))
          return undefined;
        // The first batched history request is too large for the cap; the rest answer normally.
        return ++asofRequests === 1
          ? new Response('[]', { status: 200, headers: { 'content-length': '99999999' } })
          : undefined;
      },
    });
    const r = await call(ctx({ limits: { ...DEFAULT_LIMITS, maxRows: 500 } }), {});
    expect(r['isError'], text(r)).toBeUndefined();
    const out = s(r);
    expect(out['partial']).toBe(true);
    // 2000 rows per request / 500 per page = 4 queries per request, so the seven points travel in two requests.
    const history = asofCalls(fake.calls);
    expect(history).toHaveLength(2);
    expect((history[0]?.body as unknown[] | undefined)?.length).toBe(4);
    expect(out['notes']).toEqual(
      expect.arrayContaining([expect.stringContaining('4 history points are left out')]),
    );
    const points = out['burndown'] as Array<{ at: string }>;
    // The three points of the second request and the live last point remain.
    expect(points).toHaveLength(4);
    expect(out['totals']).toMatchObject({ itemCount: 5 });
  });

  it('reports lower bounds and no history for a sprint with more items than the pages read', async () => {
    const w = world();
    const many = Array.from({ length: 6 }, (_, i) => item(200 + i, 'Story', 42, 2, 1));
    const { ctx, fake } = setup({ assets: { ...w.assets, PrimaryWorkitem: many } });
    const r = await call(ctx({ limits: { ...DEFAULT_LIMITS, maxRows: 1 } }), { sprint: 'Timebox:42' });
    expect(r['isError'], text(r)).toBeUndefined();
    const out = s(r);
    expect(out['partial']).toBe(true);
    expect(out['totals']).toMatchObject({ itemCount: 5, estimate: 5 });
    expect(out['burndown']).toBeUndefined();
    expect(out['committed']).toBeUndefined();
    expect(asofCalls(fake.calls)).toHaveLength(0);
    expect(out['notes']).toEqual(expect.arrayContaining([expect.stringContaining('lower bounds')]));
  });
});

describe('authorization', () => {
  it('answers a sprint outside the workspace like a missing one: no item query, no data', async () => {
    const { ctx, fake } = setup();
    const r = await call(ctx(), { sprint: 'Timebox:99' });
    expect(r['isError']).toBe(true);
    expect(text(r)).toContain('AB_NOT_FOUND');
    expect(JSON.stringify(r)).not.toContain('Elsewhere');
    expect(fake.calls.some((c) => JSON.stringify(c.body ?? '').includes('PrimaryWorkitem'))).toBe(false);
  });

  it('drops items outside the workspace even when the upstream ignores every filter', async () => {
    const { ctx } = setup({ filters: 'ignore-filters' });
    const r = await call(ctx(), { sprint: 'Timebox:42', burndown: false });
    expect(r['isError'], text(r)).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('Scope:2000');
    expect(JSON.stringify(r)).not.toContain('B-00009');
  });

  it('is partial when rows outside the workspace were left out of the totals (P6-13)', async () => {
    const foreign = () => ({ ...item(9, 'Story', 41, 2, 1), Scope: 'Scope:2000' });
    const hist = (p: (n: number, plain: string) => string) =>
      snapshots(p).map((snap) => ({ ...snap, rows: [...snap.rows, foreign()] }));
    // With every filter ignored the upstream answers rows of other projects; the recheck drops them.
    const { ctx } = setup({ ...world(false, undefined, hist), filters: 'ignore-filters' });
    const r = await call(ctx(), { sprint: 'Timebox:41', burndown: false });
    expect(r['isError'], text(r)).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('B-00009');
    expect(text(r)).toContain('left out');
    expect(s(r)['partial']).toBe(true);
  });

  it('is refused, with no upstream request, when neither backlog items nor defects are allowed', async () => {
    const { ctx, fake } = setup();
    const r = await call(ctx({ assetTypes: { deny: ['Story', 'Defect'] } }), { sprint: 'Sprint 42' });
    expect(r['isError']).toBe(true);
    expect(text(r)).toContain('AB_AUTH_FORBIDDEN');
    expect(fake.requests).toBe(0);
  });

  it('never queries a project outside the workspace when one is named', async () => {
    const { ctx } = setup();
    const r = await call(ctx(), { project: 'Outside', sprint: 'current' });
    expect(r['isError']).toBe(true);
    expect(JSON.stringify(r)).not.toContain('Elsewhere');
  });
});

describe('untrusted text and cost', () => {
  it('keeps poisoned sprint, status and item names inside the envelope on every output path', async () => {
    const { ctx } = setup({}, true);
    const { leaks, result } = await probeTool(getSprint, ctx(), { sprint: 'Timebox:42' });
    expect(result['isError'], text(result)).toBeUndefined();
    expect(leaks).toEqual([]);
  });

  it.each([
    [{ sprint: 'Sprint 41' }],
    [{ sprint: 'Sprint 42', team: 'Blue', project: 'Mobile App' }],
    [{ sprint: 'current' }],
    [{ sprint: 'next' }],
  ])('stays within its declared cost on a cold cache: %o', async (args) => {
    const { ctx, fake } = setup();
    const m = await measureCost(getSprint, fake, (o) => ctx(o), args);
    expect(m.requests).toBeGreaterThan(0);
    expect(m.withinCost, `${m.requests} > ${m.declared}`).toBe(true);
  });
});
