// SPDX-License-Identifier: Apache-2.0
// P6-07 composite reports on a synthetic world: sections read only through granted sibling tools, skipped or failed
// sections named and never counted as zero, budget exhaustion, partial upstream failures, scope on every row,
// poisoned text, cold costs.
import { describe, expect, it } from 'vitest';
import { createBudget, DEFAULT_LIMITS } from '../../src/index.ts';
import { BACKLOG_ITEM_QUALITY_RUBRIC } from '../../src/rubric.ts';
import { CORE_TOOLS } from '../../src/tools/index.ts';
import { defectTriage, nameSimilarity } from '../../src/tools/reports/defect-triage.ts';
import { assess, type Facts, hasGivenWhenThen, summarise } from '../../src/tools/reports/quality.ts';
import { readinessVerdict } from '../../src/tools/reports/release-readiness.ts';
import { paceStatus } from '../../src/tools/reports/sprint-health.ts';
import { findLeaks } from '../harness/index.ts';
import { NOW, rig, SIBLINGS, s, text, toolByName } from './reports-world.ts';

const REPORTS = Object.keys(SIBLINGS);
const ARGS: Record<string, Record<string, unknown>> = {
  sprint_health: { sprint: 'current' },
  standup_summary: { member: 'me', time_range: 'last 3 days' },
  release_readiness: { asset: 'E-00001' },
  defect_triage: {},
  work_item_quality: { asset: 'B-01002' },
};
const sections = (
  r: Record<string, unknown>,
): Array<{ key: string; tool: string; status: string; errorCode?: string }> => s(r).sections;
const status = (r: Record<string, unknown>, key: string) => sections(r).find((x) => x.key === key)?.status;
/** Tool names whose sibling requests reached the fake, by the type the query reads. */
const queried = (bodies: string[], type: string) =>
  bodies.filter((b) => b.includes(`"from":"${type}"`)).length;

describe('the catalogue: reports are in their own opt-in group', () => {
  it('registers the five reports in group reports, read-only, with a declared cost above their siblings', () => {
    for (const name of REPORTS) {
      const tool = toolByName(name);
      expect(tool.group).toBe('reports');
      expect(tool.kind).toBe('read');
      for (const sibling of SIBLINGS[name] ?? [])
        expect(tool.cost).toBeGreaterThanOrEqual(toolByName(sibling).cost);
    }
    expect(CORE_TOOLS.filter((t) => t.group === 'reports')).toHaveLength(5);
  });
});

describe('sprint_health notes from the sibling (P6-13)', () => {
  it('forwards them as untrusted data: none stands outside the envelope as our own text', async () => {
    const { call } = rig();
    const r = await call('sprint_health', ARGS['sprint_health'] as Record<string, unknown>);
    const out = text(r);
    expect(out).toContain('Sprint note:');
    const outside = out.replace(/<untrusted-data[\s\S]*?<\/untrusted-data[^>]*>/g, '');
    expect(outside).not.toContain('Sprint note:');
  });
});

describe('sprint_health', () => {
  it('reads the sprint and its open work and reports pace, scope change, defects, unowned and stale items', async () => {
    const { call } = rig();
    const r = await call('sprint_health', ARGS['sprint_health'] as Record<string, unknown>);
    expect(r['isError'], text(r)).toBeUndefined();
    const out = s(r);
    expect(sections(r).map((x) => [x.key, x.status])).toEqual([
      ['sprint', 'ok'],
      ['open_work', 'ok'],
    ]);
    // 5 of 16 estimate done (31.3%) at 46.4% of the time: 15 points behind.
    expect(out.pace).toMatchObject({
      status: 'at_risk',
      donePercent: 31.3,
      doneBasis: 'estimate',
      elapsedPercent: 46.4,
    });
    expect(out.scopeChange).toEqual({ addedAfterStart: 1, removedSinceStart: 0 });
    expect(out.openDefects).toEqual({ count: 1, lowerBound: false });
    // Open work: story 1002, 1004, defects 1101, and the task; two have no owner, one is older than 3 days.
    expect(out.openWork).toMatchObject({ openItemsRead: 4, unowned: 2, stale: 1, lowerBound: false });
    expect(out.staleItems.map((i: { number: string }) => i.number)).toEqual(['B-01004']);
    expect(text(r)).not.toContain('Row from another project');
  });

  it('says a pace applies to a current sprint only and never invents one for an empty sprint', async () => {
    const { call } = rig();
    const r = await call('sprint_health', { sprint: 'Empty sprint' });
    const out = s(r);
    expect(out.pace.status).toBe('unknown');
    expect(out.pace).not.toHaveProperty('donePercent');
    expect(text(r)).toContain('applies to a current sprint only');
    expect(out.openWork).toMatchObject({ openItemsRead: 0 });
  });

  it('skips the open-work section when search_work_items is not granted, without calling it', async () => {
    const { call, bodies } = rig();
    const r = await call(
      'sprint_health',
      { sprint: 'current' },
      { granted: ['sprint_health', 'get_sprint'] },
    );
    expect(status(r, 'open_work')).toBe('skipped');
    expect(text(r)).toContain('search_work_items is not granted');
    expect(queried(bodies, 'Story') + queried(bodies, 'Defect')).toBe(0);
    expect(s(r)).not.toHaveProperty('openWork');
    expect(s(r).partial).toBe(true);
    // The sprint figures remain; the missing ones are absent, never zero.
    expect(s(r).pace.status).toBe('at_risk');
  });

  it('skips the sprint section when get_sprint is not granted: no pace, no totals, no zero', async () => {
    const { call, bodies } = rig();
    const r = await call(
      'sprint_health',
      { sprint: 'current' },
      { granted: ['sprint_health', 'search_work_items'] },
    );
    expect(status(r, 'sprint')).toBe('skipped');
    expect(queried(bodies, 'Timebox')).toBeLessThanOrEqual(1); // only the name resolution of the open-work section
    const out = s(r);
    expect(out.pace.status).toBe('unknown');
    for (const key of ['totals', 'openDefects', 'committed', 'scopeChange'])
      expect(out).not.toHaveProperty(key);
    expect(out.openWork.openItemsRead).toBeGreaterThan(0);
  });

  it('with no sibling granted answers with every section skipped and makes no Agility request', async () => {
    const { call, fake } = rig();
    const r = await call('sprint_health', { sprint: 'current' }, { granted: ['sprint_health'] });
    expect(r['isError']).toBeUndefined();
    expect(sections(r).map((x) => x.status)).toEqual(['skipped', 'skipped']);
    expect(s(r).partial).toBe(true);
    expect(fake.requests).toBe(0);
  });

  it('reports a failed section by code and keeps the section that was read', async () => {
    // The search section's queries (Story/Defect/Task/Test) are refused by the upstream; get_sprint reads PrimaryWorkitem.
    const failing = rig({
      override: (_req, c) => {
        const body = JSON.stringify(c.body ?? '');
        return /"from":"(?:Story|Defect|Task|Test)"/.test(body)
          ? new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } })
          : undefined;
      },
    });
    const r = await failing.call('sprint_health', { sprint: 'current' });
    expect(r['isError'], text(r)).toBeUndefined();
    expect(sections(r).map((x) => [x.key, x.status])).toEqual([
      ['sprint', 'ok'],
      ['open_work', 'failed'],
    ]);
    expect(sections(r)[1]?.errorCode).toMatch(/^AB_/);
    expect(text(r)).toContain('Section "Open work" failed');
    expect(s(r)).not.toHaveProperty('openWork');
    expect(s(r).partial).toBe(true);
  });

  it('throws the first error when no section could be read (an unknown sprint is not an empty report)', async () => {
    const { call } = rig();
    const r = await call('sprint_health', { sprint: 'Timebox:999' });
    expect(r['isError']).toBe(true);
    expect(text(r)).toMatch(/AB_(?:NOT_FOUND|INPUT_INVALID)/);
  });

  it('stops at its budget: the sections that did not fit are not_run, the one that was read stays', async () => {
    const probe = rig();
    await probe.call('sprint_health', { sprint: 'current' }, { granted: ['sprint_health', 'get_sprint'] });
    const used = probe.fake.requests;
    const { call } = rig();
    const r = await call('sprint_health', { sprint: 'current' }, { ctx: { budget: createBudget(used) } });
    expect(sections(r).map((x) => [x.key, x.status])).toEqual([
      ['sprint', 'ok'],
      ['open_work', 'not_run'],
    ]);
    expect(sections(r)[1]?.errorCode).toBe('AB_BUDGET_EXHAUSTED');
    expect(s(r)).not.toHaveProperty('openWork');
    expect(s(r).partial).toBe(true);
  });

  it('is an error when the budget is spent before anything could be read', async () => {
    const { call } = rig();
    const r = await call('sprint_health', { sprint: 'current' }, { ctx: { budget: createBudget(2) } });
    expect(r['isError']).toBe(true);
    expect(text(r)).toContain('AB_BUDGET_EXHAUSTED');
  });
});

describe('standup_summary', () => {
  it('lists what finished, what changed and what is in progress for a member, and says blockers are not read', async () => {
    const { call } = rig();
    const r = await call('standup_summary', ARGS['standup_summary'] as Record<string, unknown>);
    expect(r['isError'], text(r)).toBeUndefined();
    const out = s(r);
    expect(sections(r).map((x) => x.status)).toEqual(['ok', 'ok']);
    expect(out.finished.map((i: { number: string }) => i.number)).toEqual(['B-01001']);
    expect(out.changed.map((i: { number: string }) => i.number).sort()).toEqual([
      'B-01002',
      'D-01103',
      'TK-01201',
    ]);
    // Tasks have no status category on this instance, so only the story is in progress.
    expect(out.inProgress.map((i: { number: string }) => i.number)).toEqual(['B-01002']);
    expect(out.blockers).toBe('not_reported');
    expect(text(r)).toContain('Blockers are not reported');
    expect(out.window.until).toBe(new Date(NOW).toISOString());
  });

  it('tells "read, none" from "not read": an empty window is empty lists, a skipped section is absent', async () => {
    const { call } = rig();
    const empty = await call('standup_summary', { member: 'me', time_range: '2026-01-01 to 2026-01-02' });
    expect(s(empty).finished).toEqual([]);
    expect(s(empty).changed).toEqual([]);
    const skipped = await call('standup_summary', { member: 'me' }, { granted: ['standup_summary'] });
    expect(sections(skipped).map((x) => x.status)).toEqual(['skipped', 'skipped']);
    for (const key of ['finished', 'changed', 'inProgress']) expect(s(skipped)).not.toHaveProperty(key);
    expect(text(skipped)).toContain('not read');
  });

  it('refuses a window longer than the workspace allows before any request', async () => {
    const { call, fake } = rig();
    const r = await call('standup_summary', { member: 'me', time_range: 'last 400 days' });
    expect(r['isError']).toBe(true);
    expect(text(r)).toContain('maxTimeRangeDays');
    expect(fake.requests).toBe(0);
  });

  it('keeps the section that was read when the other fails upstream', async () => {
    const { call } = rig({
      override: (_req, c) => {
        const body = JSON.stringify(c.body ?? '');
        // The in-progress section filters on status ids; the changed section sorts by change date.
        return body.includes('StoryStatus:2') && body.includes('"sort":["ID"]')
          ? new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } })
          : undefined;
      },
    });
    const r = await call('standup_summary', { member: 'me' });
    expect(r['isError'], text(r)).toBeUndefined();
    expect(sections(r).map((x) => x.status)).toEqual(['ok', 'failed']);
    expect(s(r)).not.toHaveProperty('inProgress');
    expect(s(r)).toHaveProperty('finished');
  });
});

describe('release_readiness', () => {
  it('says not_ready with the open items and defects it read', async () => {
    const { call } = rig();
    const r = await call('release_readiness', { asset: 'E-00001' });
    expect(r['isError'], text(r)).toBeUndefined();
    expect(s(r).verdict).toBe('not_ready');
    expect(s(r).counts).toMatchObject({ items: expect.any(Number), open: expect.any(Number) });
    expect(s(r).counts.open).toBeGreaterThan(0);
  });

  it('says ready only when everything was read and nothing is open', async () => {
    const { call } = rig({ allDone: true });
    const r = await call('release_readiness', { asset: 'E-00001' });
    expect(s(r).verdict).toBe('ready');
    expect(s(r).counts).toMatchObject({ open: 0, openDefects: 0, lowerBound: false });
  });

  it('says ready for a finished epic with more items than the listing cap (P6-13)', async () => {
    // The tree lists at most 100 backlog items for the report but counted all 126: the counts are complete.
    const { call } = rig({ allDone: true, extraStories: 120 });
    const r = await call('release_readiness', { asset: 'E-00001' });
    expect(r['isError'], text(r)).toBeUndefined();
    expect(s(r).verdict).toBe('ready');
    expect(s(r).counts).toMatchObject({ open: 0, lowerBound: false });
    expect(s(r).counts.items).toBeGreaterThan(120);
    expect(text(r)).not.toContain('counts are lower bounds');
  });

  it('does not report a percentage by estimate while open items have none (P6-13)', async () => {
    // Estimated items are partly done; eight more are open and unestimated: the estimate alone would hide them.
    const { call } = rig({ extraStories: 8, extraOpen: true });
    const r = await call('release_readiness', { asset: 'E-00001' });
    expect(r['isError'], text(r)).toBeUndefined();
    const epic = s(r).epic as Record<string, unknown>;
    expect(epic['donePercentBasis']).toBe('count');
    expect(epic['unestimatedItemCount']).toBeGreaterThanOrEqual(8);
    expect(epic['donePercent']).toBeLessThan(50);
  });

  it('says unknown, not ready, for an epic with no backlog items and for an incomplete read', async () => {
    const { call } = rig({ allDone: true });
    const empty = await call('release_readiness', { asset: 'E-00003' });
    expect(s(empty).verdict).toBe('unknown');
    expect(text(empty)).toContain('readiness cannot be judged');
    // A budget that stops the tree part-way never yields `ready`: an error, or a partial read that cannot say ready.
    const probe = rig({ allDone: true });
    await probe.call('release_readiness', { asset: 'E-00001' });
    const used = probe.fake.requests;
    for (const budget of [used - 1, used - 3, used - 6]) {
      const r = await rig({ allDone: true }).call(
        'release_readiness',
        { asset: 'E-00001' },
        { ctx: { budget: createBudget(budget) } },
      );
      expect(r['isError'] === true || s(r).verdict !== 'ready').toBe(true);
    }
  });

  it('skips its one section without get_portfolio_tree and reads nothing', async () => {
    const { call, fake } = rig();
    const r = await call('release_readiness', { asset: 'E-00001' }, { granted: ['release_readiness'] });
    expect(r['isError']).toBeUndefined();
    expect(status(r, 'tree')).toBe('skipped');
    expect(s(r).verdict).toBe('unknown');
    expect(s(r)).not.toHaveProperty('counts');
    expect(fake.requests).toBe(0);
  });

  it('answers an asset that is not an epic and an epic type the workspace denies with an error and no data', async () => {
    const { call } = rig();
    const story = await call('release_readiness', { asset: 'B-01001' });
    expect(story['isError']).toBe(true);
    const denied = rig();
    const r = await denied.call(
      'release_readiness',
      { asset: 'E-00001' },
      { ctx: { assetTypes: { deny: ['Epic'] } } },
    );
    expect(r['isError']).toBe(true);
    expect(text(r)).toContain('AB_AUTH_FORBIDDEN');
    expect(queried(denied.bodies, 'Epic')).toBe(0);
  });
});

describe('defect_triage, when more defects exist than one page (P6-13)', () => {
  it('reads the oldest change first so the stale ones are in the page, and says so', async () => {
    const { call } = rig();
    const r = await call('defect_triage', {}, { ctx: { limits: { ...DEFAULT_LIMITS, maxRows: 2 } } });
    expect(r['isError'], text(r)).toBeUndefined();
    expect(s(r).counts).toMatchObject({ openRead: 2, stale: 1, lowerBound: true });
    expect(s(r).flagged.map((f: { number?: string }) => f.number)).toContain('D-01102');
    expect(text(r)).toContain('oldest change first');
  });
});

describe('defect_triage', () => {
  it('flags defects without an owner or sprint or unchanged for a while, and likely duplicates', async () => {
    const { call } = rig();
    const r = await call('defect_triage', {});
    expect(r['isError'], text(r)).toBeUndefined();
    const out = s(r);
    // 1101 (no owner), 1102 (no owner, no sprint, stale), 1103 (no sprint); the closed and foreign ones are not read.
    expect(out.counts).toMatchObject({ openRead: 3, noOwner: 2, noSprint: 2, stale: 1, lowerBound: false });
    expect(out.flagged[0]).toMatchObject({ number: 'D-01102', flags: ['no_owner', 'no_sprint', 'stale'] });
    expect(out.likelyDuplicates).toHaveLength(1);
    expect([out.likelyDuplicates[0].first, out.likelyDuplicates[0].second].sort()).toEqual([
      'D-01102',
      'D-01103',
    ]);
    expect(out.likelyDuplicates[0].similarity).toBe(0.86);
    expect(text(r)).not.toContain('another project');
    expect(text(r)).toContain('Priority and severity are not read');
  });

  it('reads a real zero from an empty project and says nothing was flagged', async () => {
    const { call } = rig();
    const r = await call('defect_triage', { sprint: 'Empty sprint' });
    expect(s(r).counts).toMatchObject({ openRead: 0, noOwner: 0 });
    expect(s(r).flagged).toEqual([]);
  });

  it('skips its section without search_work_items; nothing is counted', async () => {
    const { call, fake } = rig();
    const r = await call('defect_triage', {}, { granted: ['defect_triage'] });
    expect(status(r, 'open_defects')).toBe('skipped');
    expect(s(r)).not.toHaveProperty('counts');
    expect(text(r)).toContain('were not read');
    expect(fake.requests).toBe(0);
  });

  it('hides rows the upstream returned outside the workspace', async () => {
    const { call } = rig({ fake: { filters: 'ignore-filters' } });
    const r = await call('defect_triage', {});
    expect(text(r)).not.toContain('another project');
    expect(JSON.stringify(s(r))).not.toContain('2101');
  });

  it('refuses when the workspace denies the defect type, with no upstream read', async () => {
    const { call, bodies } = rig();
    const r = await call('defect_triage', {}, { ctx: { assetTypes: { deny: ['Defect'] } } });
    expect(r['isError']).toBe(true);
    expect(queried(bodies, 'Defect')).toBe(0);
  });
});

describe('work_item_quality', () => {
  it('scores a story with the versioned rubric and cites its version', async () => {
    const { call } = rig();
    const r = await call('work_item_quality', { asset: 'B-01002' });
    expect(r['isError'], text(r)).toBeUndefined();
    const out = s(r);
    expect(out.rubric).toEqual({
      id: BACKLOG_ITEM_QUALITY_RUBRIC.id,
      version: BACKLOG_ITEM_QUALITY_RUBRIC.version,
    });
    expect(out.criteria.map((c: { id: string }) => c.id)).toEqual(
      BACKLOG_ITEM_QUALITY_RUBRIC.criteria.map((c) => c.id),
    );
    const byId = Object.fromEntries(out.criteria.map((c: { id: string; score: unknown }) => [c.id, c.score]));
    expect(byId).toMatchObject({
      clear_title: 2,
      user_value: 2,
      acceptance_criteria: 0,
      size: 2,
      clarity: 2,
    });
    expect(out.scoreMin).toBeLessThanOrEqual(out.scoreMax);
    expect(text(r)).toContain(
      `rubric ${BACKLOG_ITEM_QUALITY_RUBRIC.id} ${BACKLOG_ITEM_QUALITY_RUBRIC.version}`,
    );
  });

  it('turns an unassessable criterion into null and a score range, with no level when the range spans two', async () => {
    const { call } = rig();
    // Story 1004 has no description link to an owner or team and the priority could not be proven: ready_to_start.
    const r = await call('work_item_quality', { asset: 'B-01004' });
    const out = s(r);
    const ready = out.criteria.find((c: { id: string }) => c.id === 'ready_to_start');
    // Priority is not set on the fake's rows, so one part is missing; an unassessed score would be absent and flagged.
    expect(ready.assessed).toBe(ready.score !== undefined);
    expect(
      out.criteria.every(
        (c: { assessed: boolean; score?: number }) => c.assessed === (c.score !== undefined),
      ),
    ).toBe(true);
    if (out.score === undefined) expect(out.scoreMax).toBeGreaterThan(out.scoreMin);
    else expect(out.scoreMax).toBe(out.scoreMin);
  });

  it('refuses an asset the rubric does not apply to', async () => {
    const { call } = rig();
    const r = await call('work_item_quality', { asset: 'TK-01201' });
    expect(r['isError']).toBe(true);
    expect(text(r)).toContain('AB_INPUT_INVALID');
  });

  it('skips its section without get_work_item: not scored, no criteria, no request', async () => {
    const { call, fake } = rig();
    const r = await call('work_item_quality', { asset: 'B-01002' }, { granted: ['work_item_quality'] });
    expect(r['isError']).toBeUndefined();
    expect(status(r, 'item')).toBe('skipped');
    expect(s(r).criteria).toEqual([]);
    expect(s(r)).not.toHaveProperty('score');
    expect(text(r)).toContain('not scored');
    expect(fake.requests).toBe(0);
  });

  it('answers an asset outside the workspace like a missing one, with no data', async () => {
    const { call } = rig();
    const r = await call('work_item_quality', { asset: 'B-02001' });
    expect(r['isError']).toBe(true);
    expect(text(r)).toContain('AB_NOT_FOUND');
    expect(text(r)).not.toContain('another project');
  });
});

describe('the rubric checks', () => {
  const facts = (over: Partial<Facts> = {}): Facts => ({
    name: 'Sign in with a saved password',
    description: 'As a user I want to sign in so that I see my account.',
    acceptance:
      'Given a saved password when I open the app then I am signed in\nIt shows an error when the password is wrong\nIt locks after five tries',
    hasAcceptanceField: true,
    estimate: 3,
    hasEstimateField: true,
    hasEpic: true,
    hasProject: true,
    hasOwnerOrTeam: true,
    hasPriority: true,
    ...over,
  });
  const score = (over: Partial<Facts>) =>
    Object.fromEntries(BACKLOG_ITEM_QUALITY_RUBRIC.criteria.map((c) => [c.id, assess(c, facts(over)).score]));

  it('scores a complete item 100 and names its level', () => {
    const results = BACKLOG_ITEM_QUALITY_RUBRIC.criteria.map((c) => assess(c, facts()));
    expect(summarise(results)).toMatchObject({
      score: 100,
      scoreMin: 100,
      scoreMax: 100,
      level: 'ready',
      unassessed: [],
    });
  });

  it('scores the weak cases low and never guesses what was not read', () => {
    expect(
      score({ name: 'Fix', description: '', acceptance: undefined, estimate: undefined, hasEpic: false }),
    ).toMatchObject({
      clear_title: 0,
      user_value: 0,
      acceptance_criteria: 0,
      size: 0,
      clarity: null,
    });
    expect(score({ estimate: 21 })['size']).toBe(1);
    expect(score({ hasEstimateField: false, estimate: undefined })['size']).toBeNull();
    expect(score({ description: 'TBD how this works? etc ??' })['clarity']).toBe(0);
    expect(score({ hasPriority: undefined })['ready_to_start']).toBeNull();
    expect(
      score({ hasPriority: undefined, hasProject: false, hasOwnerOrTeam: false })['ready_to_start'],
    ).toBe(0);
    expect(score({ hasPriority: false })['ready_to_start']).toBe(1);
  });

  it('gives a range and a level only when the whole range lies in one level', () => {
    const results = BACKLOG_ITEM_QUALITY_RUBRIC.criteria.map((c) =>
      assess(c, facts({ hasPriority: undefined })),
    );
    const sum = summarise(results);
    expect(sum.score).toBeUndefined();
    expect(sum.unassessed).toEqual(['ready_to_start']);
    expect(sum.scoreMax - sum.scoreMin).toBe(10);
    const low = summarise(
      BACKLOG_ITEM_QUALITY_RUBRIC.criteria.map((c) =>
        assess(
          c,
          facts({
            name: 'x',
            description: '',
            acceptance: undefined,
            estimate: undefined,
            hasPriority: undefined,
            hasOwnerOrTeam: false,
            hasProject: false,
            hasEpic: false,
          }),
        ),
      ),
    );
    expect(low.level).toBe('not ready');
  });
});

describe('the rubric checks on hostile text (P6-13)', () => {
  const criterion = (id: string) => {
    const c = BACKLOG_ITEM_QUALITY_RUBRIC.criteria.find((x) => x.id === id);
    if (c === undefined) throw new Error(id);
    return c;
  };
  const base: Facts = {
    name: 'Sign in with a saved password',
    description: '',
    acceptance: undefined,
    hasAcceptanceField: false,
    estimate: 3,
    hasEstimateField: true,
    hasEpic: true,
    hasProject: true,
    hasOwnerOrTeam: true,
    hasPriority: true,
  };

  it('finds given, when, then in order without backtracking on text that has no then', () => {
    const hostile = 'given when '.repeat(400); // 4.4 KB, no "then": cubic with a `given.*when.*then` regexp
    const t0 = performance.now();
    assess(criterion('acceptance_criteria'), { ...base, acceptance: hostile });
    expect(performance.now() - t0).toBeLessThan(50);
    expect(hasGivenWhenThen('Given a when b then c')).toBe(true);
    expect(hasGivenWhenThen('then when given')).toBe(false);
    expect(hasGivenWhenThen('given then when')).toBe(false);
  });

  it('scores only the text after "acceptance criteria" when there is no acceptance field', () => {
    const prose =
      'It should be quick. It shows a lot. It returns many things. Please read the acceptance criteria';
    const withPhrase = assess(criterion('acceptance_criteria'), { ...base, description: prose });
    expect(withPhrase.score).toBe(0); // nothing follows the phrase
    const real = assess(criterion('acceptance_criteria'), {
      ...base,
      description:
        'Intro.\nAcceptance criteria:\n- It shows an error when wrong\n- It locks after five tries\n- It returns the user',
    });
    expect(real.score).toBe(2);
  });
});

describe('derived verdicts', () => {
  it('paces only a current sprint and only from known figures', () => {
    expect(paceStatus('current', 50, 50)).toBe('on_track');
    expect(paceStatus('current', 40, 50)).toBe('on_track');
    expect(paceStatus('current', 30, 50)).toBe('at_risk');
    expect(paceStatus('current', 10, 50)).toBe('off_track');
    expect(paceStatus('past', 100, 100)).toBe('unknown');
    expect(paceStatus('current', undefined, 50)).toBe('unknown');
    expect(paceStatus('current', 50, undefined)).toBe('unknown');
  });

  it('is ready only with everything read and nothing open', () => {
    const base = { items: 4, doneItems: 4, openDefects: 0, complete: true };
    expect(readinessVerdict(base)).toBe('ready');
    expect(readinessVerdict({ ...base, complete: false })).toBe('unknown');
    expect(readinessVerdict({ ...base, items: 0, doneItems: 0 })).toBe('unknown');
    expect(readinessVerdict({ ...base, doneItems: 3 })).toBe('not_ready');
    expect(readinessVerdict({ ...base, openDefects: 1, complete: false })).toBe('not_ready');
    expect(readinessVerdict({ ...base, items: undefined })).toBe('unknown');
  });

  it('compares names by word overlap and refuses to compare very short ones', () => {
    expect(
      nameSimilarity('Crash on save when the network drops', 'Crash on save when the network drops again'),
    ).toBeGreaterThan(0.8);
    expect(nameSimilarity('Crash on save', 'Crash on save')).toBe(0);
    expect(nameSimilarity('Login page layout broken', 'Invoice export fails nightly')).toBe(0);
    expect(defectTriage.name).toBe('defect_triage');
  });
});

describe('every report: poisoned text, scope and cost', () => {
  it.each(REPORTS)('%s shows no Agility text outside an envelope', async (name) => {
    const { call } = rig({ poisoned: true });
    const r = await call(name, ARGS[name] as Record<string, unknown>);
    expect(r['isError'], text(r)).toBeUndefined();
    expect(findLeaks(r)).toEqual([]);
  });

  it.each(REPORTS)('%s stays within its declared cost on a cold cache', async (name) => {
    const { call, fake } = rig();
    const before = fake.requests;
    const r = await call(name, ARGS[name] as Record<string, unknown>, {
      ctx: { budget: createBudget(1_000) },
    });
    expect(r['isError'], text(r)).toBeUndefined();
    expect(fake.requests - before).toBeLessThanOrEqual(toolByName(name).cost);
  });

  it.each(REPORTS)('%s never reads with a tool the caller was not granted', async (name) => {
    const { call, fake } = rig();
    const r = await call(name, ARGS[name] as Record<string, unknown>, { granted: [name] });
    expect(fake.requests).toBe(0);
    expect(r['isError'] === true || sections(r).every((x) => x.status === 'skipped')).toBe(true);
  });

  it.each(REPORTS)(
    '%s answers a workspace that allows none of its types with an error and no Agility read',
    async (name) => {
      const { call, bodies } = rig();
      const r = await call(name, ARGS[name] as Record<string, unknown>, {
        ctx: { assetTypes: { allow: ['Scope'], deny: [] } },
      });
      expect(r['isError']).toBe(true);
      // The number lookup selects the number only: no title, description or other Agility text is read or returned.
      expect(bodies.filter((b) => /"select":\[(?!"Number"\])/.test(b))).toEqual([]);
      expect(text(r)).not.toContain('sign in');
    },
  );
});
