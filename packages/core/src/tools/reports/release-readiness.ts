// SPDX-License-Identifier: Apache-2.0
// release_readiness (P6-07): is an epic (the release container) finished? Read through get_portfolio_tree: roll-ups of
// the epic and its sub-epics plus the backlog items below them. `ready` needs everything read and nothing open; an
// incomplete read can only say `not_ready` (open work was seen) or `unknown` (L-033).
import { z } from 'zod';
import { capBudget } from '../../context.ts';
import { shapeOutput, untrusted } from '../../output/result.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { getPortfolioTree } from '../portfolio/get-tree.ts';
import {
  allQueries,
  arr,
  incomplete,
  numOf,
  reportOutput,
  rethrowIfNothingRead,
  runSection,
  sectionInfos,
  sectionNotes,
  strOf,
} from './common.ts';

const NAME = 'release_readiness';
/** get_portfolio_tree (20). */
const COST = 20;
const LIST_CAP = 20;
const TITLES = { tree: 'Portfolio tree' };

export type Readiness = 'ready' | 'not_ready' | 'unknown';

export function readinessVerdict(input: {
  readonly items: number | undefined;
  readonly doneItems: number | undefined;
  readonly openDefects: number | undefined;
  readonly complete: boolean;
}): Readiness {
  const { items, doneItems, openDefects, complete } = input;
  if (items === undefined || doneItems === undefined || openDefects === undefined) return 'unknown';
  if (items - doneItems > 0 || openDefects > 0) return 'not_ready';
  return complete && items > 0 ? 'ready' : 'unknown';
}

export const releaseReadiness: ToolDefinition = defineTool({
  name: NAME,
  title: 'Release readiness',
  description:
    'Judge whether an epic (a release or initiative) is finished: open backlog items, open defects, unestimated open items and the sub-epics still short of done, from its portfolio tree. Verdict ready only when everything was read and nothing is open; not_ready when open work was seen; otherwise unknown. Not paged. A cold call can make up to 20 Agility requests.',
  kind: 'read',
  group: 'reports',
  // get_portfolio_tree, capped at its own cost.
  cost: COST,
  inputSchema: z.object({
    asset: z.string().min(1).max(64).describe('Epic number (E-01234) or OID token (Epic:1234).'),
    depth: z.number().int().min(1).max(4).default(2).describe('Levels of sub-epics below the epic to read.'),
  }),
  outputSchema: reportOutput({
    verdict: z.string(),
    epic: z.looseObject({}).optional(),
  }),
  handler: async (input, outer) => {
    const ctx = { ...outer, budget: capBudget(outer.budget, COST) };
    const run = await runSection(ctx, 'tree', getPortfolioTree, {
      asset: input.asset,
      depth: input.depth,
      include_items: true,
      max_items: Math.min(100, ctx.limits.maxRows),
    });
    const runs = [run];
    rethrowIfNothingRead(runs);
    const notes = sectionNotes(runs, TITLES);
    const data = run.data;
    const nodes = arr(data?.['nodes']);
    const rootOid = strOf(data?.['root']);
    const root = nodes.find((n) => n['oid'] === rootOid) ?? nodes[0];
    const backlog = arr(data?.['backlogItems']);
    const items = numOf(root?.['itemCount']);
    const doneItems = numOf(root?.['doneItemCount']);
    const openDefects = numOf(root?.['openDefectCount']);
    const treePartial = data?.['partial'] === true || root?.['incomplete'] === true;
    const complete = run.info.status === 'ok' && !treePartial;
    const verdict = readinessVerdict({ items, doneItems, openDefects, complete });
    if (run.info.status === 'ok') {
      if (treePartial)
        notes.push(
          'The tree read is incomplete (a cap, depth, budget or permission cut it): counts are lower bounds.',
        );
      if (items === 0)
        notes.push('No backlog items were read below this epic, so readiness cannot be judged.');
      if (verdict === 'ready')
        notes.push('Ready means: nothing open among the items read. Tests and dependencies are not read.');
    }
    const open = items === undefined || doneItems === undefined ? undefined : items - doneItems;
    const listComplete = items !== undefined && backlog.length >= items;
    const openItems = backlog.filter((i) => i['done'] !== true);
    const unestimatedOpen = openItems.filter((i) => numOf(i['estimate']) === undefined).length;
    if (run.info.status === 'ok' && !listComplete && items !== undefined && items > 0)
      notes.push('The listed backlog items are cut: the unestimated count is a lower bound.');
    const shortEpics = nodes
      .filter((n) => n['oid'] !== root?.['oid'])
      .filter(
        (n) => numOf(n['itemCount']) !== numOf(n['doneItemCount']) || (numOf(n['openDefectCount']) ?? 0) > 0,
      )
      .slice(0, LIST_CAP)
      .map((n) => ({
        ...(strOf(n['number']) === undefined ? {} : { number: n['number'] }),
        oid: n['oid'],
        ...(strOf(n['name']) === undefined ? {} : { name: n['name'] }),
        ...(numOf(n['donePercent']) === undefined ? {} : { donePercent: n['donePercent'] }),
        ...(numOf(n['openDefectCount']) === undefined ? {} : { openDefectCount: n['openDefectCount'] }),
        ...(n['incomplete'] === true ? { incomplete: true } : {}),
      }));
    const openRows = openItems.slice(0, LIST_CAP).map((i) => ({
      ...(strOf(i['number']) === undefined ? {} : { number: i['number'] }),
      assetType: i['assetType'],
      oid: i['oid'],
      ...(strOf(i['status']) === undefined ? {} : { status: i['status'] }),
      ...(numOf(i['estimate']) === undefined ? {} : { estimate: i['estimate'] }),
      ...(strOf(i['name']) === undefined ? {} : { name: i['name'] }),
    }));
    const rootName = strOf(root?.['name']);
    const figures = [
      ...(items === undefined ? [] : [{ figure: 'items', value: items }]),
      ...(open === undefined ? [] : [{ figure: 'open_items', value: open }]),
      ...(openDefects === undefined ? [] : [{ figure: 'open_defects', value: openDefects }]),
      ...(run.info.status === 'ok' && items !== undefined && items > 0
        ? [{ figure: 'unestimated_open_items', value: unestimatedOpen }]
        : []),
      ...(numOf(root?.['donePercent']) === undefined
        ? []
        : [{ figure: 'done_percent', value: root?.['donePercent'] }]),
    ];
    const { output } = shapeOutput(ctx, {
      summary:
        rootName === undefined
          ? `Release readiness: ${verdict.replace('_', ' ')} (the portfolio tree was not read).`
          : [
              'Release readiness of ',
              untrusted(rootName),
              `: ${verdict.replace('_', ' ')}${open === undefined ? '' : `, ${open} open item${open === 1 ? '' : 's'}`}${openDefects === undefined ? '' : `, ${openDefects} open defect${openDefects === 1 ? '' : 's'}`}.`,
            ],
      notes,
      blocks: [
        { title: 'Figures', source: 'readiness figures', rows: figures },
        ...(shortEpics.length === 0
          ? []
          : [{ title: 'Sub-epics not done', source: 'sub-epics', rows: shortEpics }]),
        ...(openRows.length === 0
          ? []
          : [{ title: 'Open backlog items', source: 'open items', rows: openRows }]),
      ],
      partial: incomplete(runs) || treePartial,
      structured: {
        sections: sectionInfos(runs),
        verdict,
        ...(root === undefined ? {} : { epic: root }),
        ...(items === undefined
          ? {}
          : {
              counts: {
                items,
                ...(open === undefined ? {} : { open }),
                ...(openDefects === undefined ? {} : { openDefects }),
                ...(run.info.status === 'ok' && items > 0
                  ? { unestimatedOpen, unestimatedLowerBound: !listComplete }
                  : {}),
                lowerBound: treePartial,
              },
            }),
        subEpicsNotDone: shortEpics,
        openItems: openRows,
      },
      meta: { queries: allQueries(runs) },
    });
    return output;
  },
});
