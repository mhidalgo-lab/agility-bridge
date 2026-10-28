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
import {
  checkCursorShape,
  cursorBinding,
  decodeCursor,
  encodeCursor,
  fingerprintOf,
} from '../../query/cursor.ts';
import { invalid } from '../../query/limits.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { cursorArg, epicArg, formatArg } from '../common.ts';
import { identityFor } from '../work/items.ts';
import { EPIC, epicFields, epicRow, isReadable, requireReadable, runBatch } from './epics.ts';

const NAME = 'get_portfolio_tree';
const COST = 20;
const MAX_DEPTH = 4;
/** Pages of backlog items read per type for the roll-ups (each page is at most the workspace's row maximum). */
const ITEM_PAGES = 3;
const ITEM_TYPES = ['Story', 'Defect'] as const;
/** The most epics a continuation cursor carries running totals for (the cursor stays under its length limit). */
const MAX_CURSOR_NODES = 60;
const MAX_CURSOR_CHARS = 1_900;

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
  /** Items read below this epic (itself included) that have no estimate. */
  unestimated: number;
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
/** The most epics one item query names (the compiler's limit for a server-built `in` list). */
const MAX_EPICS_IN_ITEM_QUERY = 2_000;
const budgetOut = (e: unknown) => e instanceof AbError && e.code === ErrorCode.BudgetExhausted;

/** Running totals per epic as compact text: `index:items,done,open,estimate,doneEstimate,unestimated,estimated;`. */
function packSums(list: readonly Node[]): string {
  return list
    .flatMap((n, i) =>
      n.items === 0
        ? []
        : [
            `${i}:${[n.items, n.doneItems, n.openDefects, n.estimate, n.doneEstimate, n.unestimated, n.estimated ? 1 : 0].join(',')}`,
          ],
    )
    .join(';');
}

/** Puts carried totals back on the epics; false when the text does not fit this tree (a forged or stale cursor). */
function restoreSums(list: readonly Node[], text: string): boolean {
  if (text === '') return true;
  const seen = new Set<number>();
  for (const part of text.split(';')) {
    const [index, values] = part.split(':');
    const i = Number(index);
    const v = (values ?? '').split(',').map(Number);
    const node = list[i];
    if (!Number.isInteger(i) || node === undefined || seen.has(i) || v.length !== 7) return false;
    if (v.some((x) => !Number.isFinite(x) || x < 0) || (v[6] !== 0 && v[6] !== 1)) return false;
    const [items, done, open, estimate, doneEstimate, unestimated, estimated] = v as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    if (done > items || open > items || unestimated > items || !Number.isInteger(items)) return false;
    seen.add(i);
    node.items = items;
    node.doneItems = done;
    node.openDefects = open;
    node.estimate = estimate;
    node.doneEstimate = doneEstimate;
    node.unestimated = unestimated;
    node.estimated = estimated === 1;
  }
  return true;
}

export const getPortfolioTree: ToolDefinition = defineTool({
  name: NAME,
  title: 'Get a portfolio tree',
  description:
    'Get an epic with its descendant epics down to a depth (at most 4) and roll-ups per epic over the backlog items below it: item counts, done items, open defects, estimate and done percentage. Roll-ups touched by a depth, size or permission cut are marked incomplete and the result is partial. Paged: pass nextCursor back as cursor. Only the last step of a large epic is exact. Cold call: up to 20 Agility requests.',
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
    cursor: cursorArg,
    format: formatArg,
  }),
  outputSchema: z.looseObject({
    root: z.string(),
    nodes: z.array(z.looseObject({ assetType: z.string(), oid: z.string() })),
    backlogItems: z.array(z.looseObject({ assetType: z.string(), oid: z.string() })).optional(),
    nextCursor: z.string().optional(),
    partial: z.boolean().optional(),
    notes: z.array(z.string()).optional(),
    hiddenOutsideScope: z.boolean().optional(),
  }),
  handler: async (input, outer) => {
    const ctx = { ...outer, budget: capBudget(outer.budget, COST) };
    checkCursorShape(ctx, input.cursor); // a malformed cursor is refused first and costs no request (L-318)
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
    const binding = await cursorBinding(ctx, NAME, {
      asset: target.oid,
      depth,
      maxItems,
      includeItems: input.include_items === true,
    });
    const carried = input.cursor === undefined ? undefined : await decodeCursor(ctx, input.cursor, binding);
    if (
      carried !== undefined &&
      (carried.sums === undefined || carried.fingerprint === undefined || carried.offsets === undefined)
    )
      throw invalid(
        'The cursor does not belong to this request.',
        'Pass nextCursor back unchanged, with the same arguments.',
      );
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
        unestimated: 0,
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
    let inFrontier = new Set(frontier);
    let levelResult = firstLevel;
    let depthReached = 0;
    for (let level = 1; level <= depth; level++) {
      if (level > 1) {
        try {
          [levelResult] = await runBatch(ctx, [await childrenOf(frontier.slice(0, MAX_EPICS_IN_ITEM_QUERY))]);
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
        if (parent === undefined || !inFrontier.has(parent)) continue; // an upstream that ignored the filter
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
      inFrontier = new Set(frontier);
      if (frontier.length === 0) break;
    }

    // Everything below the last level read, and the backlog items, in one request.
    const itemTypes: string[] = [];
    const skipped: string[] = [];
    await md.prefetch(ITEM_TYPES); // one round of loads instead of one round trip per type
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
    // The server-built `in` list is bounded by the compiler (2,000 values): a bigger tree is cut here, said so, and
    // marked incomplete rather than failing the call.
    const allOids = [...nodes.keys()];
    const epicOids = allOids.slice(0, MAX_EPICS_IN_ITEM_QUERY);
    if (allOids.length > epicOids.length) {
      cut = true;
      notes.push(
        `The tree has ${allOids.length} epics; backlog items are read for the first ${epicOids.length} only, so the roll-ups are incomplete. Get a sub-epic for exact numbers.`,
      );
    }
    const pageSize = ctx.limits.maxRows;
    const items: ItemRow[] = [];
    let itemsCut = false;
    const startAt = (type: string) => carried?.offsets?.[type] ?? 0;
    const resumeAt: Record<string, number> = {};
    // A continuation: the same epics, then the running totals of the items already read (P6-16).
    const treeFingerprint = await fingerprintOf(allOids.join(','));
    let carriedCut = false;
    if (carried !== undefined) {
      if (
        carried.fingerprint !== treeFingerprint ||
        !restoreSums(
          allOids.map((o) => nodes.get(o) as Node),
          carried.sums ?? '',
        )
      ) {
        throw invalid(
          'The tree changed since that cursor was issued.',
          'Start again without a cursor: the epics under this one are not the same.',
        );
      }
      carriedCut = carried.cut === true;
    }
    let active =
      carried === undefined ? [...itemTypes] : itemTypes.filter((t) => carried.offsets?.[t] !== undefined);
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
                filters: [
                  {
                    field: 'Super',
                    op: 'in',
                    value: frontier.slice(0, MAX_EPICS_IN_ITEM_QUERY),
                    trusted: true,
                  },
                ],
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
                offset: startAt(type) + page * pageSize,
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
            else {
              itemsCut = true;
              resumeAt[type] = startAt(type) + ITEM_PAGES * pageSize;
            }
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
    if (hidden > 0) {
      cut = true;
      notes.push(
        'Some rows outside the workspace’s Agility projects were hidden and are not in the roll-ups.',
      );
    }
    if (carriedCut) cut = true;
    // What cut the totals for good (everything above) travels in the cursor; a later step cannot undo it.
    const cutForGood = cut;

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
        if (estimate === undefined) at.unestimated++;
        if (estimate !== undefined) {
          at.estimated = true;
          at.estimate += estimate;
          if (done) at.doneEstimate += estimate;
        }
        at = at.parent === undefined ? undefined : nodes.get(at.parent);
      }
    }
    // More items remain and the tree is small enough for the totals to travel: a cursor continues the read (P6-16).
    let nextCursor: string | undefined;
    if (itemsCut) {
      const sums =
        nodes.size <= MAX_CURSOR_NODES ? packSums(allOids.map((o) => nodes.get(o) as Node)) : undefined;
      if (sums !== undefined) {
        const candidate = encodeCursor(binding, {
          offset: 0,
          offsets: resumeAt,
          sums,
          fingerprint: treeFingerprint,
          ...(cutForGood ? { cut: true } : {}),
        });
        if (candidate.length <= MAX_CURSOR_CHARS) nextCursor = candidate;
      }
      cut = true; // until the last step the roll-ups cover only what was read so far
      notes.push(
        nextCursor === undefined
          ? `More than ${ITEM_PAGES * pageSize} items of one type sit under this epic and the tree is too large to continue; the roll-ups cover the items read so far. Get a sub-epic for exact numbers.`
          : `More than ${ITEM_PAGES * pageSize} items of one type sit under this epic; the roll-ups cover the items read so far. Pass nextCursor back as cursor to read on: the last step is exact.`,
      );
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
      if (n.parent === undefined) continue;
      const siblings = kids.get(n.parent);
      if (siblings === undefined) kids.set(n.parent, [n]);
      else siblings.push(n);
    }
    const ordered: Node[] = [];
    const walk = (n: Node) => {
      ordered.push(n);
      for (const c of kids.get(n.oid) ?? []) walk(c);
    };
    const rootNode = nodes.get(target.oid) as Node;
    walk(rootNode);
    const treeRows = ordered.map((n) => {
      // By estimate only when every item read has one: items without an estimate would add nothing to either side and
      // the percentage would read as complete while they are open (L-033).
      const basis = n.estimated && n.estimate > 0 && n.unestimated === 0 ? 'estimate' : 'count';
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
        ...(n.estimated && n.unestimated > 0 ? { unestimatedItemCount: n.unestimated } : {}),
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
        ` — ${ordered.length} epic${ordered.length === 1 ? '' : 's'} over ${depthReached} level${depthReached === 1 ? '' : 's'}, ${rootNode.items} backlog item${rootNode.items === 1 ? '' : 's'} counted.`,
      ],
      notes: [
        ...notes,
        ...(partial
          ? []
          : [
              'Done = closed or in a completed status; the percentage uses estimates when every item has one, otherwise item counts.',
            ]),
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
            'unestimatedItemCount',
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
      ...(nextCursor === undefined ? {} : { nextCursor }),
      ...(droppedRows ? { partial: true } : {}),
    };
    return { ...output, structured };
  },
});
