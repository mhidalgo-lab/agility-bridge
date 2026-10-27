// SPDX-License-Identifier: Apache-2.0
// standup_summary (P6-07): what a member moved or finished in a window and what is in progress, read through
// search_work_items twice. Blockers are not read (no blocked flag), and the report says so instead of showing none.
import { z } from 'zod';
import { capBudget } from '../../context.ts';
import { shapeOutput } from '../../output/result.ts';
import { parseTimeRange } from '../../query/time.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { myMemberArg, projectArg, teamArg, timeRangeArg } from '../common.ts';
import { searchWorkItems } from '../work/search.ts';
import {
  allQueries,
  arr,
  incomplete,
  reportOutput,
  rethrowIfNothingRead,
  runSection,
  type SectionRun,
  sectionInfos,
  sectionNotes,
  strOf,
} from './common.ts';

const NAME = 'standup_summary';
/** Two search_work_items calls (24 each). */
const COST = 48;
const PAGE = 50;
const DEFAULT_WINDOW = 'last 24 hours';
const TITLES = { changed: 'Changed in the window', in_progress: 'In progress' };

export const standupSummary: ToolDefinition = defineTool({
  name: NAME,
  title: 'Standup summary',
  description:
    'Summarise a member’s work for a standup: items changed or finished in a time_range (UTC) and items in progress, optionally within a team or Agility project. Blockers are not reported. Sections not granted or not read are named, never shown as empty. Not paged. At most 50 items per section. Cold call: up to 48 Agility requests.',
  kind: 'read',
  group: 'reports',
  // Two search_work_items calls, each capped at its own cost; the shared budget is capped here.
  cost: COST,
  inputSchema: z.object({
    member: myMemberArg,
    team: teamArg,
    project: projectArg,
    time_range: timeRangeArg(DEFAULT_WINDOW),
  }),
  outputSchema: reportOutput({
    window: z.looseObject({ since: z.string(), until: z.string() }),
  }),
  handler: async (input, outer) => {
    const ctx = { ...outer, budget: capBudget(outer.budget, COST) };
    // The window is validated before any request (L-060).
    const window = parseTimeRange(
      input.time_range ?? DEFAULT_WINDOW,
      ctx.clock.now(),
      ctx.limits.maxTimeRangeDays,
    );
    const common = {
      member: input.member,
      ...(input.team === undefined ? {} : { team: input.team }),
      ...(input.project === undefined ? {} : { project: input.project }),
      limit: Math.min(PAGE, ctx.limits.maxRows),
    };
    const changedRun = await runSection(ctx, 'changed', searchWorkItems, {
      ...common,
      include_closed: true,
      sort_by: 'recently_changed',
    });
    const progressRun = await runSection(ctx, 'in_progress', searchWorkItems, {
      ...common,
      status_category: 'in_progress',
    });
    const runs: SectionRun[] = [changedRun, progressRun];
    rethrowIfNothingRead(runs);
    const notes = sectionNotes(runs, TITLES);

    const since = Date.parse(window.since);
    const until = Date.parse(window.until);
    const brief = (r: Record<string, unknown>) => ({
      ...(strOf(r['number']) === undefined ? {} : { number: r['number'] }),
      assetType: r['assetType'],
      oid: r['oid'],
      ...(strOf(r['state']) === undefined ? {} : { state: r['state'] }),
      ...(strOf(r['status']) === undefined ? {} : { status: r['status'] }),
      ...(strOf(r['changedAt']) === undefined ? {} : { changedAt: r['changedAt'] }),
      ...(strOf(r['name']) === undefined ? {} : { name: r['name'] }),
    });
    let changed: ReturnType<typeof brief>[] | undefined;
    let finished: ReturnType<typeof brief>[] | undefined;
    if (changedRun.info.status === 'ok') {
      const rows = arr(changedRun.data?.['items']);
      const inWindow = rows.filter((r) => {
        const t = Date.parse(strOf(r['changedAt']) ?? '');
        return Number.isFinite(t) && t >= since && t < until;
      });
      const more = typeof changedRun.data?.['nextCursor'] === 'string';
      const last = rows.at(-1);
      const lastT = Date.parse(strOf(last?.['changedAt']) ?? '');
      if (more && Number.isFinite(lastT) && lastT >= since)
        notes.push('More items changed in the window than the first page: the list is not complete.');
      if (rows.some((r) => !Number.isFinite(Date.parse(strOf(r['changedAt']) ?? ''))))
        notes.push('Some items have no change date and are left out of the window.');
      changed = inWindow.filter((r) => r['state'] !== 'closed').map(brief);
      finished = inWindow.filter((r) => r['state'] === 'closed').map(brief);
      if (changedRun.data?.['hiddenOutsideScope'] === true)
        notes.push('Some items were left out because they are outside the workspace.');
    }
    let inProgress: ReturnType<typeof brief>[] | undefined;
    if (progressRun.info.status === 'ok') {
      inProgress = arr(progressRun.data?.['items']).map(brief);
      if (typeof progressRun.data?.['nextCursor'] === 'string')
        notes.push('More items are in progress than the first page: the list is not complete.');
    }
    notes.push(
      'Blockers are not reported: no blocked flag is read. Items created in the window are not told apart from changed ones.',
    );
    const count = (l: unknown[] | undefined) => (l === undefined ? 'not read' : String(l.length));
    const { output } = shapeOutput(ctx, {
      summary: `Standup ${window.since} to ${window.until}: ${count(finished)} finished, ${count(changed)} otherwise changed, ${count(inProgress)} in progress.`,
      notes,
      blocks: [
        ...(finished === undefined ? [] : [{ title: 'Finished', source: 'finished items', rows: finished }]),
        ...(changed === undefined ? [] : [{ title: 'Changed', source: 'changed items', rows: changed }]),
        ...(inProgress === undefined
          ? []
          : [{ title: 'In progress', source: 'in-progress items', rows: inProgress }]),
      ],
      partial: incomplete(runs) || notes.some((n) => n.includes('not complete')),
      structured: {
        sections: sectionInfos(runs),
        window: { ...window },
        ...(finished === undefined ? {} : { finished }),
        ...(changed === undefined ? {} : { changed }),
        ...(inProgress === undefined ? {} : { inProgress }),
        blockers: 'not_reported',
      },
      meta: { queries: allQueries(runs) },
    });
    return output;
  },
});
