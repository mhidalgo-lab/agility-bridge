// SPDX-License-Identifier: Apache-2.0
// P6-07 live suite: the composite reports against the read-only tenant. Every assertion is a boolean with our own
// label and only shapes, counts and levels reach the log: a failing comparison must never print tenant values.
// One request at a time (the context's semaphore has one slot), each report within its declared cost.
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
    limits: { ...DEFAULT_LIMITS, reports: true },
    budget: createBudget(200),
    limiter: new Semaphore(1),
    breaker: closedBreaker,
    fetch: guardedFetch(target),
    metadata,
    logger: silentLogger,
    clock: systemClock,
    random: webCryptoRandom,
  };
}

const tool = (name: string) => {
  const t = CORE_TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
};
const SIBLINGS: Record<string, string[]> = {
  sprint_health: ['get_sprint', 'search_work_items'],
  standup_summary: ['search_work_items'],
  release_readiness: ['get_portfolio_tree'],
  defect_triage: ['search_work_items'],
  work_item_quality: ['get_work_item'],
};

type Out = Record<string, unknown>;
const ok = (condition: boolean, label: string) => expect(condition, label).toBe(true);
const level = (n: number) => (n === 0 ? 'none' : n < 10 ? 'few' : n < 100 ? 'some' : '100+');
const hasNull = (v: unknown): boolean =>
  v === null || (typeof v === 'object' && Object.values(v as object).some(hasNull));

async function report(name: string, args: Record<string, unknown>, granted?: string[]) {
  const ctx = liveContext(new MetadataService());
  const tools = (granted ?? [name, ...(SIBLINGS[name] ?? [])]).map(tool);
  const result = await rpc(() => buildMcpServer({ tools, ctx }), 'tools/call', { name, arguments: args });
  // Only the error code is ever shown: details can hold tenant names.
  const code = (result['_meta'] as Record<string, { code?: string }> | undefined)?.['agility-bridge/error']
    ?.code;
  return { result, code, out: (result['structuredContent'] ?? {}) as Out, used: ctx.budget.used };
}
const sections = (out: Out) => (out['sections'] ?? []) as Array<{ key: string; status: string }>;
const summary = (out: Out) =>
  sections(out)
    .map((s) => `${s.key}:${s.status}`)
    .join(',');

describe.skipIf(!target)('composite reports against the live tenant (read-only)', () => {
  const picked: { sprint?: string; epic?: string; story?: string } = {};

  it('finds a current sprint, a story and an epic with children to run the reports on', {
    timeout: 120_000,
  }, async () => {
    const probe = agilityClient(liveContext(new MetadataService()));
    const stories = await probe.query<Array<Array<Record<string, unknown>>>>({
      from: 'Story',
      select: ['Number', 'Timebox', 'Timebox.BeginDate', 'Timebox.EndDate'],
      filter: ['Timebox!=""'],
      sort: ['-ChangeDate'],
      page: { start: 0, size: 60 },
    });
    const utc = (v: unknown) => Date.parse(`${String(v).replace(/Z$/, '')}Z`);
    for (const row of stories.data[0] ?? []) {
      const t = row['Timebox'] as { _oid?: string } | string | undefined;
      const oid = (typeof t === 'string' ? t : t?._oid)?.split(':').slice(0, 2).join(':');
      const now = Date.now();
      if (oid !== undefined && utc(row['Timebox.BeginDate']) <= now && utc(row['Timebox.EndDate']) > now)
        picked.sprint ??= oid;
      if (typeof row['Number'] === 'string') picked.story ??= row['Number'];
    }
    const epics = await agilityClient(liveContext(new MetadataService())).query<
      Array<Array<Record<string, unknown>>>
    >({
      from: 'Epic',
      select: ['Number', 'Subs.@Count'],
      sort: ['-ChangeDate'],
      page: { start: 0, size: 40 },
    });
    for (const row of epics.data[0] ?? [])
      if (typeof row['Number'] === 'string' && Number(row['Subs.@Count']) > 0) picked.epic ??= row['Number'];
    process.stderr.write(
      `live reports: sprint ${picked.sprint === undefined ? 'none' : 'found'}, story ${picked.story === undefined ? 'none' : 'found'}, epic ${picked.epic === undefined ? 'none' : 'found'}\n`,
    );
    ok(picked.story !== undefined, 'a story exists');
  });

  it('sprint_health reads both sections, a status, and stays within its cost', {
    timeout: 300_000,
  }, async () => {
    if (picked.sprint === undefined) return;
    const { out, code, used } = await report('sprint_health', { sprint: picked.sprint });
    expect(code).toBeUndefined();
    ok(used <= tool('sprint_health').cost, 'within the declared cost');
    ok(sections(out).length === 2, 'two sections');
    const pace = out['pace'] as { status: string; donePercent?: number; elapsedPercent?: number };
    ok(['on_track', 'at_risk', 'off_track', 'unknown'].includes(pace.status), 'a known status word');
    ok(
      pace.status === 'unknown' || (pace.donePercent !== undefined && pace.elapsedPercent !== undefined),
      'a status comes with the figures that make it',
    );
    ok(!hasNull(out), 'no null in the output');
    const work = out['openWork'] as { openItemsRead: number; unowned: number; stale?: number } | undefined;
    process.stderr.write(
      `live sprint_health: ${summary(out)}; status ${pace.status}; open items ${work === undefined ? 'not read' : level(work.openItemsRead)}; partial ${out['partial'] === true}\n`,
    );
  });

  it('sprint_health with one sibling not granted skips that section and never reads it', {
    timeout: 300_000,
  }, async () => {
    if (picked.sprint === undefined) return;
    const { out, code } = await report('sprint_health', { sprint: picked.sprint }, [
      'sprint_health',
      'get_sprint',
    ]);
    expect(code).toBeUndefined();
    ok(
      sections(out).some((s) => s.key === 'open_work' && s.status === 'skipped'),
      'open work is skipped',
    );
    ok(out['openWork'] === undefined, 'no open-work figures');
    ok(out['partial'] === true, 'partial');
  });

  it('standup_summary lists what changed and what is in progress for the token member', {
    timeout: 300_000,
  }, async () => {
    const { out, code, used } = await report('standup_summary', { member: 'me', time_range: 'last 30 days' });
    expect(code).toBeUndefined();
    ok(used <= tool('standup_summary').cost, 'within the declared cost');
    ok(
      sections(out).every((s) => s.status === 'ok'),
      'both sections read',
    );
    ok(
      Array.isArray(out['finished']) && Array.isArray(out['changed']) && Array.isArray(out['inProgress']),
      'lists',
    );
    ok(out['blockers'] === 'not_reported', 'blockers are said not to be read');
    ok(!hasNull(out), 'no null in the output');
    process.stderr.write(
      `live standup_summary: ${summary(out)}; finished ${level((out['finished'] as unknown[]).length)}; changed ${level((out['changed'] as unknown[]).length)}; in progress ${level((out['inProgress'] as unknown[]).length)}\n`,
    );
  });

  it('release_readiness gives a verdict with its counts for an epic with children', {
    timeout: 300_000,
  }, async () => {
    if (picked.epic === undefined) return;
    const { out, code, used } = await report('release_readiness', { asset: picked.epic });
    expect(code).toBeUndefined();
    ok(used <= tool('release_readiness').cost, 'within the declared cost');
    ok(['ready', 'not_ready', 'unknown'].includes(String(out['verdict'])), 'a known verdict word');
    const counts = out['counts'] as { items: number; open?: number } | undefined;
    ok(counts !== undefined && Number.isInteger(counts.items), 'counts come back');
    ok(
      out['verdict'] !== 'ready' || (counts?.open === 0 && out['partial'] !== true),
      'ready only when nothing is open and nothing was cut',
    );
    ok(!hasNull(out), 'no null in the output');
    process.stderr.write(
      `live release_readiness: ${summary(out)}; verdict ${String(out['verdict'])}; items ${level(counts?.items ?? 0)}; partial ${out['partial'] === true}\n`,
    );
  });

  it('defect_triage counts flagged open defects and lists them within bounds', {
    timeout: 300_000,
  }, async () => {
    const { out, code, used } = await report('defect_triage', {});
    expect(code).toBeUndefined();
    ok(used <= tool('defect_triage').cost, 'within the declared cost');
    const counts = out['counts'] as { openRead: number; noOwner: number; noSprint: number } | undefined;
    ok(counts !== undefined, 'the defects were read');
    ok((counts?.noOwner ?? 0) <= (counts?.openRead ?? 0), 'flags never exceed the defects read');
    ok(((out['flagged'] as unknown[]) ?? []).length <= 20, 'the flagged list is bounded');
    ok(((out['likelyDuplicates'] as unknown[]) ?? []).length <= 10, 'the duplicate list is bounded');
    ok(!hasNull(out), 'no null in the output');
    process.stderr.write(
      `live defect_triage: ${summary(out)}; open ${level(counts?.openRead ?? 0)}; no owner ${level(counts?.noOwner ?? 0)}; no sprint ${level(counts?.noSprint ?? 0)}; duplicates ${level(((out['likelyDuplicates'] as unknown[]) ?? []).length)}\n`,
    );
  });

  it('work_item_quality scores a story with the rubric version and per-criterion evidence', {
    timeout: 300_000,
  }, async () => {
    if (picked.story === undefined) return;
    const { out, code, used } = await report('work_item_quality', { asset: picked.story });
    expect(code).toBeUndefined();
    ok(used <= tool('work_item_quality').cost, 'within the declared cost');
    const rubric = out['rubric'] as { id: string; version: string };
    ok(
      rubric.id === 'backlog-item-quality' && /^\d+\.\d+\.\d+$/.test(rubric.version),
      'the rubric is cited by version',
    );
    const criteria = out['criteria'] as Array<{
      id: string;
      score?: number;
      assessed: boolean;
      evidence: string;
    }>;
    ok(criteria.length === 6, 'six criteria');
    ok(
      criteria.every(
        (c) =>
          c.assessed === (c.score !== undefined) && (c.score === undefined || [0, 1, 2].includes(c.score)),
      ),
      'scores are 0 to 2, absent exactly when not assessed',
    );
    const min = out['scoreMin'] as number;
    const max = out['scoreMax'] as number;
    ok(min >= 0 && max <= 100 && min <= max, 'the range is inside 0 to 100');
    ok(
      out['score'] === undefined || (out['score'] === min && min === max),
      'an exact score only without unassessed criteria',
    );
    process.stderr.write(
      `live work_item_quality: ${summary(out)}; unassessed ${criteria.filter((c) => !c.assessed).length}; level ${String(out['level'] ?? 'none')}; scores ${criteria.map((c) => c.score ?? '-').join('')}\n`,
    );
  });

  it('a report with none of its siblings granted makes no request', async () => {
    const { out, code, used } = await report('work_item_quality', { asset: picked.story ?? 'B-00001' }, [
      'work_item_quality',
    ]);
    expect(code).toBeUndefined();
    ok(used === 0, 'no Agility request');
    ok(
      sections(out).every((s) => s.status === 'skipped'),
      'every section skipped',
    );
  });
});
