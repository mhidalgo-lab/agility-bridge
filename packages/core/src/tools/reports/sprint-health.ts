// SPDX-License-Identifier: Apache-2.0
// sprint_health (P6-07): get_sprint plus the sprint's open work items, read through search_work_items. Every figure is
// derived from what the sections returned; a figure that cannot be computed is absent, never zero (L-033).
import { z } from 'zod';
import { capBudget } from '../../context.ts';
import { type Line, shapeOutput, untrusted } from '../../output/result.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { currentSprintArg, projectArg, teamArg } from '../common.ts';
import { getSprint } from '../planning/sprint.ts';
import { searchWorkItems } from '../work/search.ts';
import {
  allQueries,
  arr,
  incomplete,
  numOf,
  obj,
  reportOutput,
  rethrowIfNothingRead,
  round1,
  runSection,
  type SectionRun,
  sectionInfos,
  sectionNotes,
  strOf,
} from './common.ts';

const NAME = 'sprint_health';
/** get_sprint (30) + search_work_items (24). */
const COST = 54;
const DAY = 86_400_000;
/** An open item not changed for this long is listed as stale. */
export const STALE_DAYS = 3;
const LIST_CAP = 10;
const TITLES = { sprint: 'Sprint', open_work: 'Open work' };

export type Health = 'on_track' | 'at_risk' | 'off_track' | 'unknown';

/**
 * Pace: share done minus share of the sprint's time elapsed, in percentage points. Only a current sprint has a pace.
 * Rule: at least -10 on track, down to -25 at risk, below that off track; anything unknown stays unknown.
 */
export function paceStatus(
  timing: string | undefined,
  donePercent: number | undefined,
  elapsedPercent: number | undefined,
): Health {
  if (timing !== 'current' || donePercent === undefined || elapsedPercent === undefined) return 'unknown';
  const gap = donePercent - elapsedPercent;
  return gap >= -10 ? 'on_track' : gap >= -25 ? 'at_risk' : 'off_track';
}

export const sprintHealth: ToolDefinition = defineTool({
  name: NAME,
  title: 'Sprint health',
  description:
    'Report a sprint’s health in one call: share done against share of time elapsed (a status only for a current sprint), scope change since the start, unestimated items, open defects, open items without an owner or unchanged for 3 days. Sections not granted or not read are named, never counted as zero. Not paged. Cold call: up to 54 Agility requests.',
  kind: 'read',
  group: 'reports',
  // get_sprint and search_work_items, each capped at its own cost; the shared budget is capped here.
  cost: COST,
  inputSchema: z.object({
    sprint: currentSprintArg,
    team: teamArg,
    project: projectArg,
  }),
  outputSchema: reportOutput({
    sprint: z.looseObject({}).optional(),
    pace: z.looseObject({ status: z.string() }),
  }),
  handler: async (input, outer) => {
    const ctx = { ...outer, budget: capBudget(outer.budget, COST) };
    const now = ctx.clock.now();
    const scope = {
      ...(input.team === undefined ? {} : { team: input.team }),
      ...(input.project === undefined ? {} : { project: input.project }),
    };
    const sprintRun = await runSection(ctx, 'sprint', getSprint, {
      sprint: input.sprint,
      ...scope,
      burndown: true,
    });
    const sprintData = sprintRun.data;
    const sprint = obj(sprintData?.['sprint']);
    const oid = strOf(sprint?.['oid']);
    const workRun = await runSection(ctx, 'open_work', searchWorkItems, {
      sprint: oid ?? input.sprint,
      ...scope,
      include_closed: false,
      sort_by: 'recently_changed',
      limit: Math.min(100, ctx.limits.maxRows),
    });
    const runs: SectionRun[] = [sprintRun, workRun];
    rethrowIfNothingRead(runs);
    const notes: Line[] = sectionNotes(runs, TITLES);
    // The sibling's notes were already flattened to text; a note that carries an Agility name would otherwise reach the
    // model outside the envelope. They are forwarded as untrusted data, never as our own text (P6-13).
    for (const n of Array.isArray(sprintData?.['notes']) ? (sprintData['notes'] as unknown[]) : [])
      if (typeof n === 'string') notes.push(['Sprint note: ', untrusted(n)]);

    // Pace.
    const timing = strOf(sprint?.['timing']);
    const begin = Date.parse(strOf(sprint?.['beginDate']) ?? '');
    const end = Date.parse(strOf(sprint?.['endDate']) ?? '');
    const totals = obj(sprintData?.['totals']);
    const byCategory = arr(sprintData?.['byStatusCategory']);
    const items = numOf(totals?.['itemCount']);
    const doneItems = numOf(byCategory.find((c) => c['category'] === 'completed')?.['itemCount']);
    let donePercent: number | undefined;
    let basis: 'estimate' | 'items' | undefined;
    const estimate = numOf(totals?.['estimate']);
    const doneEstimate = numOf(totals?.['done']);
    if (estimate !== undefined && estimate > 0 && doneEstimate !== undefined) {
      donePercent = round1((doneEstimate / estimate) * 100);
      basis = 'estimate';
    } else if (items !== undefined && items > 0 && doneItems !== undefined) {
      donePercent = round1((doneItems / items) * 100);
      basis = 'items';
    }
    const elapsedPercent =
      timing === 'current' && Number.isFinite(begin) && Number.isFinite(end) && end > begin
        ? round1(Math.min(100, Math.max(0, ((now - begin) / (end - begin)) * 100)))
        : undefined;
    const status = paceStatus(timing, donePercent, elapsedPercent);
    if (sprintRun.info.status === 'ok' && status === 'unknown')
      notes.push(
        timing === 'current'
          ? 'No pace status: the share done could not be computed from what was read.'
          : 'A pace status applies to a current sprint only.',
      );
    if (sprintData?.['partial'] === true)
      notes.push('The sprint section is partial: its figures may be lower bounds.');

    // Scope change and defects come from the sprint section.
    const committed = obj(sprintData?.['committed']);
    const scopeChange = obj(sprintData?.['scopeChange']);
    const added = numOf(scopeChange?.['addedAfterStart']);
    const committedItems = numOf(committed?.['itemCount']);
    const sprintItems = arr(sprintData?.['items']);
    const listComplete = items !== undefined && sprintItems.length >= items;
    const openDefects =
      sprintRun.info.status === 'ok'
        ? sprintItems.filter((i) => i['assetType'] === 'Defect' && i['category'] !== 'completed').length
        : undefined;
    if (openDefects !== undefined && !listComplete)
      notes.push('The sprint’s item list is cut: the open defect count is a lower bound.');

    // Open work.
    const rows = arr(workRun.data?.['items']);
    const more = typeof workRun.data?.['nextCursor'] === 'string' || workRun.data?.['truncated'] === true;
    const owned = (r: Record<string, unknown>) => Array.isArray(r['owners']) && r['owners'].length > 0;
    const changedMs = (r: Record<string, unknown>) => Date.parse(strOf(r['changedAt']) ?? '');
    const unowned = rows.filter((r) => !owned(r));
    const withDate = rows.filter((r) => Number.isFinite(changedMs(r)));
    const stale = withDate.filter((r) => now - changedMs(r) > STALE_DAYS * DAY);
    if (workRun.info.status === 'ok') {
      if (more) notes.push('More open items exist than were read: the counts of open work are lower bounds.');
      if (withDate.length < rows.length)
        notes.push(
          `${rows.length - withDate.length} open items have no change date and are not in the stale count.`,
        );
      if (workRun.data?.['hiddenOutsideScope'] === true)
        notes.push('Some items were left out because they are outside the workspace.');
    }
    const workSignals =
      workRun.info.status === 'ok'
        ? {
            openItemsRead: rows.length,
            unowned: unowned.length,
            ...(withDate.length === 0 && rows.length > 0 ? {} : { stale: stale.length }),
            lowerBound: more,
          }
        : undefined;

    const signals = [
      ...(donePercent === undefined ? [] : [{ signal: 'done_percent', value: donePercent, basis }]),
      ...(elapsedPercent === undefined
        ? []
        : [{ signal: 'elapsed_percent', value: elapsedPercent, basis: 'dates (UTC)' }]),
      ...(added === undefined || committedItems === undefined || committedItems === 0
        ? []
        : [
            {
              signal: 'items_added_after_start_percent',
              value: round1((added / committedItems) * 100),
              basis: 'items',
            },
          ]),
      ...(numOf(totals?.['unestimatedItems']) === undefined
        ? []
        : [{ signal: 'unestimated_items', value: numOf(totals?.['unestimatedItems']), basis: 'items' }]),
      ...(openDefects === undefined
        ? []
        : [{ signal: 'open_defects', value: openDefects, basis: listComplete ? 'items' : 'lower bound' }]),
      ...(workSignals === undefined
        ? []
        : [
            {
              signal: 'open_items_without_owner',
              value: workSignals.unowned,
              basis: more ? 'lower bound' : 'items',
            },
            ...(workSignals.stale === undefined
              ? []
              : [
                  {
                    signal: `open_items_unchanged_${STALE_DAYS}_days`,
                    value: workSignals.stale,
                    basis: more ? 'lower bound' : 'items',
                  },
                ]),
          ]),
    ];
    const brief = (r: Record<string, unknown>) => ({
      ...(strOf(r['number']) === undefined ? {} : { number: r['number'] }),
      assetType: r['assetType'],
      oid: r['oid'],
      ...(strOf(r['status']) === undefined ? {} : { status: r['status'] }),
      ...(strOf(r['changedAt']) === undefined ? {} : { changedAt: r['changedAt'] }),
      ...(strOf(r['name']) === undefined ? {} : { name: r['name'] }),
    });
    const staleRows = [...stale]
      .sort((a, b) => changedMs(a) - changedMs(b))
      .slice(0, LIST_CAP)
      .map(brief);
    const unownedRows = unowned.slice(0, LIST_CAP).map(brief);
    const sprintName = strOf(sprint?.['name']);
    const { output } = shapeOutput(ctx, {
      summary:
        sprintName === undefined
          ? `Sprint health: the sprint section was not read; ${status}.`
          : [
              'Sprint ',
              untrusted(sprintName),
              `: ${status.replace('_', ' ')}${donePercent === undefined ? '' : `, ${donePercent}% done`}${elapsedPercent === undefined ? '' : ` at ${elapsedPercent}% of the time`}.`,
            ],
      notes,
      blocks: [
        { title: 'Signals', source: 'sprint signals', rows: signals },
        ...(staleRows.length === 0
          ? []
          : [{ title: 'Open items unchanged', source: 'stale items', rows: staleRows }]),
        ...(unownedRows.length === 0
          ? []
          : [{ title: 'Open items without an owner', source: 'unowned items', rows: unownedRows }]),
      ],
      partial:
        incomplete(runs) ||
        sprintData?.['partial'] === true ||
        more ||
        workRun.data?.['hiddenOutsideScope'] === true,
      structured: {
        sections: sectionInfos(runs),
        ...(sprint === undefined ? {} : { sprint }),
        pace: {
          status,
          rule: 'done share minus elapsed share: at least -10 on track, down to -25 at risk, below off track',
          ...(donePercent === undefined ? {} : { donePercent, doneBasis: basis }),
          ...(elapsedPercent === undefined ? {} : { elapsedPercent }),
        },
        ...(totals === undefined ? {} : { totals }),
        ...(committed === undefined ? {} : { committed }),
        ...(scopeChange === undefined ? {} : { scopeChange }),
        ...(openDefects === undefined
          ? {}
          : { openDefects: { count: openDefects, lowerBound: !listComplete } }),
        ...(workSignals === undefined ? {} : { openWork: workSignals }),
        staleItems: staleRows,
        unownedItems: unownedRows,
      },
      meta: { queries: allQueries(runs) },
    });
    return output;
  },
});
