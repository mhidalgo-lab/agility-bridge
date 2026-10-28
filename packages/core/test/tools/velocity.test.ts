// SPDX-License-Identifier: Apache-2.0
// P6-17 get_velocity: completed estimate of the last past sprints, each read as it ended. Synthetic world: three past
// sprints (the newest with a done item, one with only unestimated done work, an old one), a running sprint that must
// never count, and a sprint of another Agility project.
import { describe, expect, it } from 'vitest';
import {
  buildMcpServer,
  createBudget,
  DEFAULT_LIMITS,
  MetadataService,
  type ToolContext,
} from '../../src/index.ts';
import { getVelocity } from '../../src/tools/planning/velocity.ts';
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
  sprint: number,
  status: number,
  estimate: number | undefined,
  team = 'Team:5',
): Row => ({
  _oid: `Story:${id}`,
  AssetType: 'Story',
  Number: `B-${String(id).padStart(5, '0')}`,
  Name: `Synthetic item ${id}`,
  AssetState: status === 3 ? 128 : 64,
  Scope: 'Scope:1001',
  Team: team,
  Timebox: `Timebox:${sprint}`,
  Status: `StoryStatus:${status}`,
  Estimate: estimate ?? null,
});

const sprint = (id: number, name: string, begin: string, end: string, schedule = 'Schedule:1'): Row => ({
  _oid: `Timebox:${id}`,
  Name: name,
  BeginDate: begin,
  EndDate: end,
  AssetState: 128,
  Schedule: schedule,
  'Schedule.Name': `Synthetic ${schedule}`,
  'Workitems.Team': ['Team:5'],
  'Schedule.ScheduledScopes': schedule === 'Schedule:1' ? ['Scope:1001'] : ['Scope:2000'],
});

function world(poisoned = false): Pick<FakeAgilityOptions, 'assets' | 'history'> {
  const p = (n: number, plain: string) => (poisoned ? poison(n) : plain);
  const at = (rows: Row[]) => rows;
  return {
    history: {
      PrimaryWorkitem: [
        // As of the end of sprint 39 (2026-09-14): one done item of 3 points and one of 5 still open.
        { at: '2026-09-14T00:00:00Z', rows: at([item(1, 39, 3, 3), item(2, 39, 2, 5)]) },
        // As of the end of sprint 40 (2026-09-28): done work with no estimate, plus a foreign team's done item.
        {
          at: '2026-09-28T00:00:00Z',
          rows: at([item(3, 40, 3, undefined), item(4, 40, 1, 2), item(5, 40, 3, 8, 'Team:9')]),
        },
        // As of the end of sprint 41 (2026-10-12): 5 + 2 points done, 4 open.
        {
          at: '2026-10-12T00:00:00Z',
          rows: at([item(6, 41, 3, 5), item(7, 41, 3, 2), item(8, 41, 2, 4)]),
        },
      ],
    },
    assets: {
      PrimaryWorkitem: [item(20, 42, 2, 3)],
      StoryStatus: [
        { _oid: 'StoryStatus:1', Name: 'Not started', Order: 1, RollupState: 0 },
        { _oid: 'StoryStatus:2', Name: 'In progress', Order: 2, RollupState: 64 },
        { _oid: 'StoryStatus:3', Name: 'Done', Order: 3, RollupState: 128 },
      ],
      Timebox: [
        sprint(39, 'Sprint 39', '2026-09-01T00:00:00Z', '2026-09-14T00:00:00Z'),
        sprint(40, 'Sprint 40', '2026-09-15T00:00:00Z', '2026-09-28T00:00:00Z'),
        sprint(41, p(1, 'Sprint 41'), '2026-09-29T00:00:00Z', '2026-10-12T00:00:00Z'),
        sprint(42, 'Sprint 42', '2026-10-13T00:00:00Z', '2026-10-27T00:00:00Z'),
        sprint(99, 'Elsewhere', '2026-09-29T00:00:00Z', '2026-10-12T00:00:00Z', 'Schedule:9'),
      ],
      Team: [
        { _oid: 'Team:5', Name: 'Blue', AssetState: 64 },
        { _oid: 'Team:9', Name: 'Red', AssetState: 64 },
      ],
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
  rpc(() => buildMcpServer({ tools: [getVelocity], ctx }), 'tools/call', {
    name: 'get_velocity',
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

describe('velocity of past sprints', () => {
  it('reads each sprint as it ended and averages the completed estimate of the sprints read in full', async () => {
    const { ctx, fake } = setup();
    const r = await call(ctx(), { team: 'Team:5', sprints: 3 });
    expect(r['isError'], text(r)).toBeUndefined();
    const out = s(r);
    // Newest first; the running sprint 42 is not a past sprint.
    expect((out['sprints'] as Out[]).map((x) => x['oid'])).toEqual([
      'Timebox:41',
      'Timebox:40',
      'Timebox:39',
    ]);
    const [s41, s40, s39] = out['sprints'] as Out[];
    expect(s41).toMatchObject({ completedItems: 2, completedEstimate: 7, itemCount: 3 });
    // Done work without an estimate has no completed estimate, not zero, and the other team's item is not read.
    expect(s40).toMatchObject({ completedItems: 1, unestimatedCompleted: 1, itemCount: 2 });
    expect(s40?.['completedEstimate']).toBeUndefined();
    expect(s39).toMatchObject({ completedItems: 1, completedEstimate: 3 });
    expect(out['average']).toBe(5);
    expect(out['sprintsCounted']).toBe(2);
    expect(out['notes']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Sprints without a completed estimate are not in the average'),
        expect.stringContaining('Capacity is not reported'),
      ]),
    );
    // One batched request for the three sprints, none into the future.
    const history = asofCalls(fake.calls);
    expect(history).toHaveLength(1);
    expect((history[0]?.body as unknown[] | undefined)?.length).toBe(3);
  });

  it('leaves out a sprint beyond the history limit and says so', async () => {
    const { ctx } = setup();
    const r = await call(ctx({ limits: { ...DEFAULT_LIMITS, maxAsOfAgeDays: 12 } }), { sprints: 3 });
    expect(r['isError'], text(r)).toBeUndefined();
    const out = s(r);
    expect(out['partial']).toBe(true);
    expect((out['sprints'] as Out[]).filter((x) => x['read'] === false)).toHaveLength(2);
    expect(out['notes']).toEqual(expect.arrayContaining([expect.stringContaining('history limit')]));
  });

  it('leaves out the sprints of a chunk over the response cap instead of failing', async () => {
    const { ctx } = setup({
      override: (_req, c) => {
        const bodies = Array.isArray(c.body) ? c.body : [c.body];
        return c.path === 'query.v1' && bodies.some((b) => (b as { asof?: string }).asof !== undefined)
          ? new Response('[]', { status: 200, headers: { 'content-length': '99999999' } })
          : undefined;
      },
    });
    const r = await call(ctx(), { sprints: 2 });
    expect(r['isError'], text(r)).toBeUndefined();
    const out = s(r);
    expect(out['partial']).toBe(true);
    expect(out['average']).toBeUndefined();
    expect(out['notes']).toEqual(expect.arrayContaining([expect.stringContaining('did not fit')]));
  });

  it('names a sprint with more items than one page instead of estimating it', async () => {
    const { ctx } = setup();
    const r = await call(ctx({ limits: { ...DEFAULT_LIMITS, maxRows: 2 } }), { sprints: 1 });
    expect(r['isError'], text(r)).toBeUndefined();
    const out = s(r);
    expect(out['partial']).toBe(true);
    expect(out['notes']).toEqual(expect.arrayContaining([expect.stringContaining('more than 2 items')]));
  });
});

describe('authorization', () => {
  it('is refused, with no upstream request, when neither backlog items nor defects are allowed', async () => {
    const { ctx, fake } = setup();
    const r = await call(ctx({ assetTypes: { deny: ['Story', 'Defect'] } }));
    expect(r['isError']).toBe(true);
    expect(text(r)).toContain('AB_AUTH_FORBIDDEN');
    expect(fake.requests).toBe(0);
  });

  it('never reads a project outside the workspace: no sprint query, no item query, no data', async () => {
    const { ctx, fake } = setup();
    const r = await call(ctx(), { project: 'Outside' });
    expect(r['isError']).toBe(true);
    expect(JSON.stringify(r)).not.toContain('Elsewhere');
    expect(asofCalls(fake.calls)).toHaveLength(0);
  });

  it('drops items outside the workspace even when the upstream ignores every filter', async () => {
    const foreign = { ...item(9, 41, 3, 99), Scope: 'Scope:2000' };
    const w = world();
    const { ctx } = setup({
      ...w,
      history: { PrimaryWorkitem: [{ at: '2026-10-12T00:00:00Z', rows: [item(6, 41, 3, 5), foreign] }] },
      filters: 'ignore-filters',
    });
    const r = await call(ctx(), { sprints: 1 });
    expect(r['isError'], text(r)).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('Scope:2000');
    expect(JSON.stringify(r)).not.toContain('B-00009');
    expect(s(r)['partial']).toBe(true);
  });
});

describe('untrusted text and cost', () => {
  it('keeps poisoned sprint names inside the envelope on every output path', async () => {
    const { ctx } = setup({}, true);
    const { leaks, result } = await probeTool(getVelocity, ctx(), { sprints: 3 });
    expect(result['isError'], text(result)).toBeUndefined();
    expect(leaks).toEqual([]);
  });

  it.each([[{}], [{ team: 'Blue', project: 'Mobile App', sprints: 10 }]])(
    'stays within its declared cost on a cold cache: %o',
    async (args) => {
      const { ctx, fake } = setup();
      const m = await measureCost(getVelocity, fake, (o) => ctx(o), args);
      expect(m.requests).toBeGreaterThan(0);
      expect(m.withinCost, `${m.requests} > ${m.declared}`).toBe(true);
    },
  );
});
