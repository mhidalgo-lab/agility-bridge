// SPDX-License-Identifier: Apache-2.0
// get_portfolio_tree (P6-01): an epic, its descendant epics level by level (`Super`), and roll-ups over the backlog
// items that hang under them. Roll-ups are computed from the rows fetched, never guessed: anything that cuts the set
// (depth, caps, budget, permissions, hidden rows) says so and marks the roll-ups it touches `incomplete`.
import { z } from 'zod';
import { capBudget } from '../../context.ts';
import { AbError, ErrorCode } from '../../errors.ts';
import { resolveAsset } from '../../identity/resolve.ts';
import { oidsOf } from '../../identity/scope.ts';
import { metadataFor } from '../../metadata/service.ts';
import { assetState, shapeOutput, untrusted } from '../../output/result.ts';
import { type CompiledQuery, compileQuery, type FilterInput } from '../../query/compiler.ts';
import { invalid } from '../../query/limits.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { epicArg, formatArg } from '../common.ts';
import { identityFor } from '../work/items.ts';
import { EPIC, epicFields, epicRow, isReadable, requireReadable, runBatch } from './epics.ts';

const NAME = 'get_portfolio_tree';
const COST = 20;
const MAX_DEPTH = 4;
/** Pages of backlog items read per type for the roll-ups (each page is at most the workspace's row maximum). */
const ITEM_PAGES = 3;
const ITEM_TYPES = ['Story', 'Defect'] as const;

type Row = Record<string, unknown>;

interface Node {
  readonly oid: string;
  readonly row: Row;
  readonly depth: number;
  readonly parent?: string;
  items: number;
  doneItems: number;
  openDefects: number;
  estimate: number;
  doneEstimate: number;
  estimated: boolean;
  incomplete: boolean;
}

interface ItemRow {
  readonly type: string;
  readonly epic: string;
  readonly row: Row;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v === '' ? Number.NaN : Number(v);
  return v === null || v === undefined || !Number.isFinite(n) ? undefined : n;
};
const round1 = (n: number) => Math.round(n * 10) / 10;
const budgetOut = (e: unknown) => e instanceof AbError && e.code === ErrorCode.BudgetExhausted;

export const getPortfolioTree: ToolDefinition = defineTool({
  name: NAME,
  title: 'Get a portfolio tree',
  description:
    'Get an epic with its descendant epics down to a depth (at most 4) and roll-ups per epic over the backlog items below it: item counts, done items, open defects, estimate and done percentage. Roll-ups touched by a depth, size or permission cut are marked incomplete and the result is partial. Not paged. Cold call: up to 20 Agility requests.',
  kind: 'read',
  group: 'portfolio',
  // Capped at run time: Epic, Story and Defect metadata and status lists, resolution, one request per level (four at most), up to three item pages.
  cost: COST,
  inputSchema: z.object({
    asset: epicArg,
    depth: z
      .number()
      .int()
      .min(1)
      .max(MAX_DEPTH)
      .default(2)
      .describe('Levels of sub-epics below the epic to read.'),
    include_items: z
      .boolean()
      .default(false)
      .describe('Also list the backlog items under the epics (capped).'),
    max_items: z
      .number()
      .int()
      .min(1)
      .max(1_000)
      .optional()
      .describe('Most epics per level and backlog items listed; the workspace maximum when omitted.'),
    format: formatArg,
  }),
  outputSchema: z.looseObject({
    root: z.string(),
    nodes: z.array(z.looseObject({ assetType: z.string(), oid: z.string() })),
    backlogItems: z.array(z.looseObject({ assetType: z.string(), oid: z.string() })).optional(),
    partial: z.boolean().optional(),
    notes: z.array(z.string()).optional(),
    hiddenOutsideScope: z.boolean().optional(),
  }),
  handler: async (input, outer) => {
    const ctx = { ...outer, budget: capBudget(outer.budget, COST) };
    requireReadable(ctx, EPIC);
    const md = metadataFor(ctx);
    const depth = input.depth ?? 2;
    const maxItems = input.max_items ?? ctx.limits.maxRows;
    if (maxItems > ctx.limits.maxRows)
      throw invalid(`max_items is at most ${ctx.limits.maxRows} in this workspace.`);
    const notes: string[] = [];
    let hidden = 0;
    let cut = false; // something outside the roll-ups' control cut the set: every roll-up is incomplete
    const incompleteNodes = new Set<string>();

    const target = await resolveAsset(ctx, input.asset);
    if (target.assetType !== EPIC) {
      throw invalid(
        `${target.assetType} is not a portfolio item (epic).`,
        'Pass an epic number or OID token; use get_work_item for other work items.',
      );
    }
    const fields = await epicFields(ctx);
    const identity = await identityFor(EPIC, ctx);
    const compileEpics = (filters: readonly FilterInput[], limit: number) =>
      compileQuery(
        ctx,
        { assetType: EPIC, fields, filters, limit, includeClosed: true },
        { identityFields: identity },
      );
    const childrenOf = (oids: readonly string[]) =>
      compileEpics([{ field: 'Super', op: 'in', value: [...oids], trusted: true }], maxItems);

    // Level 0 (the epic itself) and level 1 share one request.
    const nodes = new Map<string, Node>();
    const add = (row: Row, level: number, parent?: string) => {
      const oid = oidsOf(row['_oid'])[0] ?? '';
      if (oid === '' || nodes.has(oid)) return false;
      nodes.set(oid, {
        oid,
        row,
        depth: level,
        ...(parent === undefined ? {} : { parent }),
        items: 0,
        doneItems: 0,
        openDefects: 0,
        estimate: 0,
        doneEstimate: 0,
        estimated: false,
        incomplete: false,
      });
      return true;
    };
    const root = await compileEpics([{ field: 'ID', op: 'eq', value: target.oid }], 1);
    const [rootRes, firstLevel] = await runBatch(ctx, [root, await childrenOf([target.oid])]);
    // Only the epic that was asked for: an upstream that ignores the filter must not substitute another (L-122).
    const rootRow = rootRes?.rows.find((r) => oidsOf(r['_oid'])[0] === target.oid);
    if (rootRow === undefined) throw invalid(`${input.asset} changed while it was read; try again.`);
    add(rootRow, 0);

    let frontier: string[] = [target.oid];
    let levelResult = firstLevel;
    let depthReached = 0;
    for (let level = 1; level <= depth; level++) {
      if (level > 1) {
        try {
          [levelResult] = await runBatch(ctx, [await childrenOf(frontier)]);
        } catch (e) {
          if (!budgetOut(e)) throw e;
          cut = true;
          notes.push(
            `The request budget ran out before level ${level}; the tree stops at level ${depthReached}.`,
          );
          break;
        }
      }
      if (levelResult === undefined) break;
      hidden += levelResult.hidden;
      const next: string[] = [];
      for (const row of levelResult.rows) {
        const parent = oidsOf(row['Super'])[0];
        if (parent === undefined || !frontier.includes(parent)) continue; // an upstream that ignored the filter
        if (add(row, level, parent)) next.push(oidsOf(row['_oid'])[0] ?? '');
      }
      if (levelResult.more) {
        cut = true;
        notes.push(
          `Level ${level} has more than ${maxItems} epics; only the first ${maxItems} are shown (max_items).`,
        );
      }
      depthReached = level;
      frontier = next;
      if (frontier.length === 0) break;
    }

    // Everything below the last level read, and the backlog items, in one request.
    const itemTypes: string[] = [];
    const skipped: string[] = [];
    for (const type of ITEM_TYPES) {
      const meta = await md.findAssetType(type);
      if (meta === undefined || !meta.attributes.has('Super')) continue;
      if (isReadable(ctx, type)) itemTypes.push(type);
      else skipped.push(type);
    }
    if (skipped.length > 0) {
      cut = true;
      notes.push(
        `${skipped.join(' and ')} are not allowed in this workspace, so the roll-ups leave them out.`,
      );
    }
    const categories = new Map<string, string | undefined>();
    for (const type of itemTypes) {
      for (const s of await md.statuses(type)) categories.set(s.oid, s.category);
    }
    const itemFields = async (type: string) => {
      const meta = await md.assetType(type);
      return [
        'Super',
        'Estimate',
        'Status',
        ...(input.include_items === true ? ['Name', 'Status.Name'] : []),
      ].filter((f) => meta.attributes.has(f.split('.')[0] as string));
    };
    const deeper = depthReached === depth && frontier.length > 0;
    const epicOids = [...nodes.keys()];
    const pageSize = ctx.limits.maxRows;
    const items: ItemRow[] = [];
    let itemsCut = false;
    let active = [...itemTypes];
    try {
      for (let page = 0; page < ITEM_PAGES && (active.length > 0 || (page === 0 && deeper)); page++) {
        const compiled: CompiledQuery[] = [];
        if (page === 0 && deeper) {
          compiled.push(
            await compileQuery(
              ctx,
              {
                assetType: EPIC,
                fields: ['Super'],
                filters: [{ field: 'Super', op: 'in', value: frontier, trusted: true }],
                limit: maxItems,
                includeClosed: true,
              },
              {},
            ),
          );
        }
        for (const type of active) {
          compiled.push(
            await compileQuery(
              ctx,
              {
                assetType: type,
                fields: await itemFields(type),
                filters: [{ field: 'Super', op: 'in', value: epicOids, trusted: true }],
                limit: pageSize,
                offset: page * pageSize,
                includeClosed: true,
              },
              { identityFields: await identityFor(type, ctx) },
            ),
          );
        }
        const results = await runBatch(ctx, compiled);
        const answers = [...results];
        if (page === 0 && deeper) {
          const probe = answers.shift();
          hidden += probe?.hidden ?? 0;
          for (const row of probe?.rows ?? []) {
            const parent = oidsOf(row['Super'])[0];
            if (parent !== undefined && nodes.has(parent)) incompleteNodes.add(parent);
          }
          if ((probe?.rows.length ?? 0) > 0) {
            if (probe?.more === true) for (const oid of frontier) incompleteNodes.add(oid);
            notes.push(
              `Epics exist below level ${depth}; raise depth (at most ${MAX_DEPTH}) or get the sub-epic. Roll-ups of the epics above them are incomplete.`,
            );
          }
        }
        const still: string[] = [];
        for (const [i, type] of active.entries()) {
          const res = answers[i];
          if (res === undefined) continue;
          hidden += res.hidden;
          for (const row of res.rows) {
            const epic = oidsOf(row['Super'])[0];
            if (epic !== undefined && nodes.has(epic)) items.push({ type, epic, row });
          }
          if (res.more) {
            if (page + 1 < ITEM_PAGES) still.push(type);
            else itemsCut = true;
          }
        }
        active = still;
      }
    } catch (e) {
      if (!budgetOut(e)) throw e;
      cut = true;
      notes.push(
        'The request budget ran out while reading backlog items; the roll-ups cover only what was read.',
      );
    }
    if (itemsCut) {
      cut = true;
      notes.push(
        `More than ${ITEM_PAGES * pageSize} items of one type sit under this epic; the roll-ups cover the first ${ITEM_PAGES * pageSize}. Get a sub-epic for exact numbers.`,
      );
    }
    if (hidden > 0) {
      cut = true;
      notes.push(
        'Some rows outside the workspace’s Agility projects were hidden and are not in the roll-ups.',
      );
    }

    // Roll-ups: each item counts for its epic and every ancestor within the tree.
    const isDone = (row: Row): boolean => {
      if (Number(row['AssetState']) === 128) return true;
      const status = oidsOf(row['Status'])[0];
      return status !== undefined && categories.get(status) === 'completed';
    };
    for (const item of items) {
      const done = isDone(item.row);
      const estimate = num(item.row['Estimate']);
      const open = item.type === 'Defect' && !done;
      let at: Node | undefined = nodes.get(item.epic);
      while (at !== undefined) {
        at.items++;
        if (done) at.doneItems++;
        if (open) at.openDefects++;
        if (estimate !== undefined) {
          at.estimated = true;
          at.estimate += estimate;
          if (done) at.doneEstimate += estimate;
        }
        at = at.parent === undefined ? undefined : nodes.get(at.parent);
      }
    }
    for (const oid of incompleteNodes) {
      let at: Node | undefined = nodes.get(oid);
      while (at !== undefined) {
        at.incomplete = true;
        at = at.parent === undefined ? undefined : nodes.get(at.parent);
      }
    }
    if (cut) for (const n of nodes.values()) n.incomplete = true;

    // Pre-order, children in the order Agility returned them.
    const kids = new Map<string, Node[]>();
    for (const n of nodes.values()) {
      if (n.parent !== undefined) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
    }
    const ordered: Node[] = [];
    const walk = (n: Node) => {
      ordered.push(n);
      for (const c of kids.get(n.oid) ?? []) walk(c);
    };
    const rootNode = nodes.get(target.oid) as Node;
    walk(rootNode);
    const treeRows = ordered.map((n) => {
      const basis = n.estimated && n.estimate > 0 ? 'estimate' : 'count';
      const percent =
        basis === 'estimate'
          ? round1((n.doneEstimate / n.estimate) * 100)
          : n.items > 0
            ? round1((n.doneItems / n.items) * 100)
            : undefined;
      return {
        ...epicRow(n.row),
        depth: n.depth,
        itemCount: n.items,
        doneItemCount: n.doneItems,
        openDefectCount: n.openDefects,
        ...(n.estimated ? { estimate: n.estimate, doneEstimate: n.doneEstimate } : {}),
        ...(percent === undefined ? {} : { donePercent: percent, donePercentBasis: basis }),
        ...(n.incomplete ? { incomplete: true } : {}),
      };
    });
    const shownItems = input.include_items === true ? items.slice(0, maxItems) : [];
    const itemRows = shownItems.map((i) => {
      const estimate = num(i.row['Estimate']);
      return {
        number: typeof i.row['Number'] === 'string' ? i.row['Number'] : undefined,
        assetType: i.type,
        oid: oidsOf(i.row['_oid'])[0] ?? '',
        state: assetState(i.row['AssetState'], i.type),
        epic: i.epic,
        ...(typeof i.row['Name'] === 'string' ? { name: i.row['Name'] } : {}),
        ...(typeof i.row['Status.Name'] === 'string' ? { status: i.row['Status.Name'] } : {}),
        ...(estimate === undefined ? {} : { estimate }),
        done: isDone(i.row),
      };
    });
    if (input.include_items === true && items.length > shownItems.length)
      notes.push(
        `Only the first ${maxItems} backlog items are listed (max_items); the roll-ups count all that were read.`,
      );

    const partial =
      cut || incompleteNodes.size > 0 || (input.include_items === true && items.length > shownItems.length);
    const { output, blocks } = shapeOutput(ctx, {
      summary: [
        `Portfolio tree of ${String(rootNode.row['Number'] ?? target.oid)}: `,
        untrusted(rootNode.row['Name']),
        ` — ${ordered.length} epic${ordered.length === 1 ? '' : 's'} over ${depthReached} level${depthReached === 1 ? '' : 's'}, ${items.length} backlog item${items.length === 1 ? '' : 's'} counted.`,
      ],
      notes: [
        ...notes,
        ...(partial
          ? []
          : ['Done = closed or in a completed status; the percentage uses estimates when items have them.']),
      ],
      blocks: [
        {
          title: 'Epics',
          source: 'portfolio tree',
          rows: treeRows,
          columns: [
            'depth',
            'number',
            'assetType',
            'oid',
            'state',
            'parent',
            'category',
            'name',
            'status',
            'itemCount',
            'doneItemCount',
            'openDefectCount',
            'estimate',
            'doneEstimate',
            'donePercent',
            'donePercentBasis',
            'incomplete',
          ],
        },
        ...(input.include_items === true
          ? [
              {
                title: 'Backlog items',
                source: 'backlog items',
                rows: itemRows,
                columns: [
                  'number',
                  'assetType',
                  'oid',
                  'state',
                  'epic',
                  'name',
                  'status',
                  'estimate',
                  'done',
                ],
              },
            ]
          : []),
      ],
      partial,
      caps: { maxRows: 1_000 },
      ...(input.format === undefined ? {} : { format: input.format }),
      meta: { queries: [root.masked] },
    });
    const shownNodes = blocks[0]?.rows ?? [];
    const backlogItems = input.include_items === true ? (blocks[1]?.rows ?? []) : undefined;
    const droppedRows = blocks.some((b) => b.droppedRows > 0);
    const structured = {
      ...(output.structured as Record<string, unknown>),
      root: target.oid,
      nodes: shownNodes as Array<{ assetType: string; oid: string }>,
      ...(backlogItems === undefined
        ? {}
        : { backlogItems: backlogItems as Array<{ assetType: string; oid: string }> }),
      ...(hidden > 0 ? { hiddenOutsideScope: true } : {}),
      ...(droppedRows ? { partial: true } : {}),
    };
    return { ...output, structured };
  },
});
