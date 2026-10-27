// SPDX-License-Identifier: Apache-2.0
// get_sprint (P6-02): what a sprint committed, what is done, what changed. Items are the sprint's backlog items and
// defects (`PrimaryWorkitem`), grouped by the instance's own status categories (L-142). "Committed" is the estimate
// at the begin date and the burndown comes from `asof` reads at bounded daily points, all in one batched request
// (ADR-0011, L-060); nothing that was not read is reported as a number (L-033).
import { z } from 'zod';
import { agilityClient } from '../../agility/client.ts';
import { capBudget, type ToolContext } from '../../context.ts';
import { AbError, ErrorCode } from '../../errors.ts';
import { resolveProject, resolveSprint, resolveTeam, runPage } from '../../identity/resolve.ts';
import { inScope, oidsOf, sanitizeRow } from '../../identity/scope.ts';
import { metadataFor, type StatusCategory } from '../../metadata/service.ts';
import { assetState, shapeOutput, untrusted } from '../../output/result.ts';
import { utcIso } from '../../output/text.ts';
import { type CompiledQuery, compileQuery } from '../../query/compiler.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { currentSprintArg, formatArg, projectArg, ref, rowOid, teamArg } from '../common.ts';
import { readableWorkTypes } from '../work/search.ts';

const NAME = 'get_sprint';
const COST = 30;
const DAY = 86_400_000;
/** Burndown points per call, begin and end included (L-060). */
const MAX_POINTS = 15;
/** Pages of items read for the sprint's contents. */
const MAX_PAGES = 5;
/** History queries per call (points times pages) and per batched request (response cap, L-049). */
const MAX_HISTORY_QUERIES = 60;
const QUERIES_PER_REQUEST = 20;
const ITEM_LIST_CAP = 100;
const CATEGORIES = ['not_started', 'in_progress', 'completed', 'unknown'] as const;
type Category = (typeof CATEGORIES)[number];

type Row = Record<string, unknown>;

interface Item {
  readonly oid: string;
  readonly row: Row;
  readonly category: Category;
  readonly estimate?: number;
}

interface Sums {
  readonly itemCount: number;
  /** Omitted when no item has an estimate: a sum of nothing is not zero (L-033). */
  readonly estimate?: number;
  readonly unestimatedItems: number;
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : undefined;
const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * A sprint date as a UTC instant. Hosted Agility returns sprint dates without a zone (live, P6-02): they are read as UTC,
 * the server's one time model (L-061), and the result says so. Anything that is not a date reads as no date (L-149).
 */
function instant(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  const iso =
    utcIso(v) ?? utcIso(`${v}Z`) ?? (/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : undefined);
  return iso === undefined ? undefined : Date.parse(iso);
}

const zoneless = (value: unknown): boolean => typeof value === 'string' && utcIso(value) === undefined;

function sums(items: readonly Item[]): Sums {
  let estimate = 0;
  let unestimatedItems = 0;
  for (const i of items) {
    if (i.estimate === undefined) unestimatedItems++;
    else estimate += i.estimate;
  }
  const known = items.length === 0 || unestimatedItems < items.length;
  return { itemCount: items.length, ...(known ? { estimate: round(estimate) } : {}), unestimatedItems };
}

/** Rows that passed the scope recheck and are of a readable work-item type. */
function keep(
  ctx: ToolContext,
  compiled: CompiledQuery,
  rows: readonly Row[],
): { kept: Row[]; hidden: number } {
  const kept: Row[] = [];
  let hidden = 0;
  for (const r of rows) {
    const type = typeof r['AssetType'] === 'string' ? r['AssetType'] : '';
    if (!inScope(ctx, compiled, r) || readableWorkTypes(ctx, [type]).length === 0) {
      hidden++;
      continue;
    }
    sanitizeRow(ctx, compiled, r);
    kept.push(r);
  }
  return { kept, hidden };
}

export const getSprint: ToolDefinition = defineTool({
  name: NAME,
  title: 'Get a sprint',
  description:
    'Get one sprint: dates (UTC), schedule, backlog items and defects by status category with estimates, committed at the begin date vs done, scope change, carry-over of a past sprint and a daily burndown from bounded history. Not paged. Cold call: up to 30 Agility requests.',
  kind: 'read',
  group: 'planning',
  // Capped at run time: team/project and sprint resolution, the sprint, metadata and status lists, up to three pages of
  // items, batched history requests.
  cost: COST,
  inputSchema: z.object({
    sprint: currentSprintArg,
    team: teamArg,
    project: projectArg,
    burndown: z.boolean().default(true).describe('Read history for committed, scope change and burndown.'),
    format: formatArg,
  }),
  outputSchema: z.looseObject({
    sprint: z.looseObject({ oid: z.string(), name: z.string() }),
    totals: z.looseObject({ itemCount: z.number(), estimate: z.number().optional() }),
    byStatusCategory: z.array(z.looseObject({ category: z.string(), itemCount: z.number() })),
    items: z.array(z.looseObject({ oid: z.string() })),
    truncated: z.boolean().optional(),
    partial: z.boolean().optional(),
    notes: z.array(z.string()).optional(),
  }),
  handler: async (input, outer) => {
    const ctx = { ...outer, budget: capBudget(outer.budget, COST) };
    const md = metadataFor(ctx);
    const types = readableWorkTypes(ctx, ['Story', 'Defect']);
    if (types.length === 0)
      throw new AbError(
        ErrorCode.AuthForbidden,
        'No backlog item or defect type is allowed in this workspace.',
      );
    const team = input.team === undefined ? undefined : (await resolveTeam(ctx, input.team)).oid;
    const project = input.project === undefined ? undefined : (await resolveProject(ctx, input.project)).oid;
    const resolved = await resolveSprint(ctx, input.sprint ?? 'current', {
      ...(team === undefined ? {} : { team }),
      ...(project === undefined ? {} : { project }),
    });

    // The sprint itself, through the compiler so the scope restriction and the recheck apply (L-064).
    const sprintQuery = await compileQuery(ctx, {
      assetType: 'Timebox',
      fields: ['Name', 'BeginDate', 'EndDate', 'AssetState', 'Schedule', 'Schedule.Name'],
      filters: [{ field: 'ID', op: 'eq', value: resolved.oid, trusted: true }],
      includeClosed: true,
      limit: 1,
    });
    const sprintRow = (await runPage(ctx, sprintQuery)).rows[0];
    if (sprintRow === undefined)
      throw new AbError(ErrorCode.NotFound, 'The sprint was not found or is not visible with this token.');
    const notes: string[] = [];
    let partial = false;
    const now = ctx.clock.now();
    const begin = instant(sprintRow['BeginDate']);
    const end = instant(sprintRow['EndDate']);
    const timing =
      begin === undefined || end === undefined
        ? undefined
        : end <= now
          ? 'past'
          : begin > now
            ? 'future'
            : 'current';
    if (timing === undefined)
      notes.push(
        'The sprint has no usable UTC begin and end dates: timing, committed and burndown are not reported.',
      );
    if (
      begin !== undefined &&
      end !== undefined &&
      (zoneless(sprintRow['BeginDate']) || zoneless(sprintRow['EndDate']))
    )
      notes.push('Agility gives sprint dates without a time zone; they are read as UTC.');
    const scheduleOid = oidsOf(sprintRow['Schedule'])[0];
    const schedule = ref(sprintRow, 'Schedule');

    // Status categories come from the instance's lists (never hard-coded names, L-142).
    const statusInfo = new Map<string, { name: string; category?: StatusCategory }>();
    await md.prefetch(types);
    for (const type of types) {
      for (const s of await md.statuses(type))
        statusInfo.set(s.oid, {
          name: s.name,
          ...(s.category === undefined ? {} : { category: s.category }),
        });
    }
    const classify = (row: Row): Category => {
      const status = oidsOf(row['Status'])[0];
      const category = status === undefined ? undefined : statusInfo.get(status)?.category;
      if (category !== undefined) return category;
      return Number(row['AssetState']) === 128 ? 'completed' : 'unknown';
    };
    const toItem = (row: Row): Item => {
      const estimate = num(row['Estimate']);
      return {
        oid: rowOid(row),
        row,
        category: classify(row),
        ...(estimate === undefined ? {} : { estimate }),
      };
    };

    const itemMeta = await md.assetType('PrimaryWorkitem');
    const has = (a: string) => itemMeta.attributes.has(a.split('.')[0] as string);
    // AssetState too: a closed item with no status category must be classified the same way at every point of the
    // burndown as in the current totals (otherwise the last point steps down by items that were never reclassified).
    const light = ['AssetType', 'Status', 'Estimate', 'AssetState'].filter(has);
    const rich = ['AssetType', 'Number', 'Name', 'Status', 'Status.Name', 'Estimate', 'AssetState'].filter(
      has,
    );
    if (!has('Estimate'))
      notes.push('This instance has no estimate on backlog items: no estimates are reported.');
    const filters = [{ field: 'Timebox', op: 'eq' as const, value: resolved.oid, trusted: true }];
    const pageSize = ctx.limits.maxRows;
    const compileItems = (fields: readonly string[], offset: number, asOf?: number) =>
      compileQuery(
        ctx,
        {
          assetType: 'PrimaryWorkitem',
          fields,
          filters,
          includeClosed: true,
          limit: pageSize,
          offset,
          ...(asOf === undefined ? {} : { asOf: new Date(asOf).toISOString() }),
        },
        { allowAbstract: true },
      );

    // The sprint's contents: as they are now, or, for a past sprint, as they were when it ended (carry-over items are
    // moved to another sprint afterwards, so "now" would hide them).
    const withinHistory = (t: number) => (now - t) / DAY <= ctx.limits.maxAsOfAgeDays;
    let basis: 'now' | 'end_of_sprint' = 'now';
    let basisAt = now;
    if (timing === 'past' && end !== undefined) {
      if (withinHistory(end)) {
        basis = 'end_of_sprint';
        basisAt = end;
      } else {
        notes.push(
          `The sprint ended more than ${ctx.limits.maxAsOfAgeDays} days ago, beyond the history limit: items are shown as they are now, and carry-over, committed and burndown are not reported.`,
        );
        partial = true;
      }
    }
    const current: Item[] = [];
    let hidden = 0;
    let capped = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const compiled = await compileItems(
        rich,
        page * pageSize,
        basis === 'end_of_sprint' ? basisAt : undefined,
      );
      const result = await runPage(ctx, compiled);
      const { kept, hidden: h } = keep(ctx, compiled, result.rows);
      hidden += h + result.hidden;
      current.push(...kept.map(toItem));
      if (!result.hasMore) break;
      if (page === MAX_PAGES - 1) capped = true;
    }
    if (capped) {
      partial = true;
      notes.push(
        `The sprint has more than ${MAX_PAGES * pageSize} items: totals cover the first ${MAX_PAGES * pageSize} and are lower bounds; burndown and scope change are not reported.`,
      );
    }
    const total = sums(current);
    const done = sums(current.filter((i) => i.category === 'completed'));
    const open = sums(current.filter((i) => i.category !== 'completed'));
    const unknownItems = current.filter((i) => i.category === 'unknown').length;
    if (total.unestimatedItems > 0)
      notes.push(
        `${total.unestimatedItems} item${total.unestimatedItems === 1 ? ' has' : 's have'} no estimate and are not in the estimate totals.`,
      );
    if (unknownItems > 0)
      notes.push(
        `${unknownItems} item${unknownItems === 1 ? ' has' : 's have'} no status category on this instance; counted as not done.`,
      );
    const byStatusCategory = CATEGORIES.flatMap((category) => {
      const group = sums(current.filter((i) => i.category === category));
      return group.itemCount === 0 && category === 'unknown' ? [] : [{ category, ...group }];
    });

    // History: begin (committed) and the days between, one batched request.
    let committed: (Sums & { at: string }) | undefined;
    let scopeChange: { addedAfterStart: number; removedSinceStart: number } | undefined;
    const burndown: Array<{ at: string; remaining?: number; itemCount: number; ideal?: number }> = [];
    let wantHistory = input.burndown !== false && begin !== undefined && end !== undefined;
    if (wantHistory && (timing === 'future' || capped)) wantHistory = false;
    if (wantHistory && basis === 'now' && timing === 'past') wantHistory = false;
    if (input.burndown !== false && timing === 'future')
      notes.push(
        'The sprint has not started: nothing is committed yet and there is no burndown; totals are the plan.',
      );
    if (wantHistory && begin !== undefined && end !== undefined) {
      const last = Math.min(end, now);
      const days = Math.max(0, Math.ceil((last - begin) / DAY));
      const pagesPerPoint = Math.min(MAX_PAGES, Math.max(1, Math.ceil((current.length * 1.25) / pageSize)));
      const maxPoints = Math.max(
        2,
        Math.min(MAX_POINTS, Math.floor(MAX_HISTORY_QUERIES / pagesPerPoint) + 1),
      );
      const step = Math.max(1, Math.ceil(days / (maxPoints - 1)));
      const times: number[] = [];
      for (let t = begin; t < last; t += step * DAY) times.push(t);
      times.push(last);
      const old = times.filter((t) => !withinHistory(t));
      const wanted = times.filter((t) => withinHistory(t) && t !== last);
      if (old.length > 0) {
        partial = true;
        notes.push(
          `${old.length} history point${old.length === 1 ? ' is' : 's are'} older than ${ctx.limits.maxAsOfAgeDays} days (the history limit) and left out.`,
        );
      }
      // Each point reads the sprint's items in `pagesPerPoint` pages (with headroom for a bigger sprint in the past); the
      // queries go out in a few batched requests that stay well under the response cap.
      const queries: Array<{ t: number; last: boolean; compiled: CompiledQuery }> = [];
      for (const t of wanted) {
        for (let page = 0; page < pagesPerPoint; page++)
          queries.push({
            t,
            last: page === pagesPerPoint - 1,
            compiled: await compileItems(light, page * pageSize, t),
          });
      }
      const rowsAt = new Map<number, { rows: Row[]; complete: boolean; compiled: CompiledQuery[] }>();
      for (let from = 0; from < queries.length; from += QUERIES_PER_REQUEST) {
        const chunk = queries.slice(from, from + QUERIES_PER_REQUEST);
        const res = await agilityClient(ctx).query<unknown[]>(chunk.map((q) => q.compiled.body));
        for (const [i, q] of chunk.entries()) {
          const set = Array.isArray(res.data) ? res.data[i] : undefined;
          const raw = Array.isArray(set)
            ? set.filter((r): r is Row => r !== null && typeof r === 'object' && !Array.isArray(r))
            : [];
          const entry = rowsAt.get(q.t) ?? { rows: [], complete: true, compiled: [] };
          entry.rows.push(...raw.slice(0, pageSize));
          // The extra row (limit + 1) of the last page means the sprint had more items than the pages read.
          if (q.last && raw.length > pageSize) entry.complete = false;
          entry.compiled.push(q.compiled);
          rowsAt.set(q.t, entry);
        }
      }
      const points = new Map<number, Item[]>();
      let incomplete = 0;
      for (const [t, entry] of rowsAt) {
        if (!entry.complete) {
          incomplete++;
          continue;
        }
        points.set(t, keep(ctx, entry.compiled[0] as CompiledQuery, entry.rows).kept.map(toItem));
      }
      if (incomplete > 0) {
        partial = true;
        notes.push(
          `${incomplete} history point${incomplete === 1 ? ' is' : 's are'} left out: the sprint had more than ${pagesPerPoint * pageSize} items then.`,
        );
      }
      points.set(last, current);
      const start = points.get(begin);
      if (start !== undefined) {
        committed = { ...sums(start), at: new Date(begin).toISOString() };
        const startOids = new Set(start.map((i) => i.oid));
        const nowOids = new Set(current.map((i) => i.oid));
        scopeChange = {
          addedAfterStart: current.filter((i) => !startOids.has(i.oid)).length,
          removedSinceStart: start.filter((i) => !nowOids.has(i.oid)).length,
        };
      } else
        notes.push(
          old.includes(begin)
            ? 'Committed is not reported: the begin date is beyond the history limit.'
            : 'Committed is not reported: the sprint’s items at its begin date could not be read in full.',
        );
      for (const t of [...times].sort((a, b) => a - b)) {
        const at = points.get(t);
        if (at === undefined) continue;
        const remaining = sums(at.filter((i) => i.category !== 'completed'));
        const ideal =
          committed === undefined || end <= begin
            ? undefined
            : committed.estimate === undefined
              ? undefined
              : round(committed.estimate * Math.max(0, Math.min(1, 1 - (t - begin) / (end - begin))));
        burndown.push({
          at: new Date(t).toISOString(),
          ...(remaining.estimate === undefined ? {} : { remaining: remaining.estimate }),
          itemCount: remaining.itemCount,
          ...(ideal === undefined ? {} : { ideal }),
        });
      }
      if (timing === 'current')
        notes.push('The last burndown point is now; earlier points are daily from the begin date (UTC).');
    }
    const carryOver = timing === 'past' && basis === 'end_of_sprint' ? open : undefined;
    notes.push(
      'Capacity is not reported: this Agility schema has no capacity model on sprints, and nothing is estimated in its place.',
    );
    const listCut = current.length > ITEM_LIST_CAP;
    if (listCut)
      notes.push(
        `The item list shows the first ${ITEM_LIST_CAP} of ${current.length} items; totals cover all of them.`,
      );
    if (hidden > 0) {
      partial = true; // the totals leave those items out: not complete (the same rule as get_portfolio_tree)
      notes.push(
        'Some items were left out because they are outside the workspace or of a type this workspace does not allow.',
      );
    }

    const itemRows = [...current]
      .sort(
        (a, b) =>
          CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.oid.localeCompare(b.oid),
      )
      .map((i) => {
        const statusName =
          typeof i.row['Status.Name'] === 'string'
            ? i.row['Status.Name']
            : statusInfo.get(oidsOf(i.row['Status'])[0] ?? '')?.name;
        return {
          ...(typeof i.row['Number'] === 'string' ? { number: i.row['Number'] } : {}),
          assetType: typeof i.row['AssetType'] === 'string' ? i.row['AssetType'] : 'PrimaryWorkitem',
          oid: i.oid,
          state: assetState(i.row['AssetState']),
          ...(typeof i.row['Name'] === 'string' ? { name: i.row['Name'] } : {}),
          ...(statusName === undefined ? {} : { status: statusName }),
          category: i.category,
          ...(i.estimate === undefined ? {} : { estimate: i.estimate }),
        };
      });
    const dateOf = (t: number | undefined) => (t === undefined ? undefined : new Date(t).toISOString());
    const sprint = {
      oid: resolved.oid,
      name: String(sprintRow['Name'] ?? resolved.name),
      state: assetState(sprintRow['AssetState']),
      ...(timing === undefined ? {} : { timing }),
      ...(begin === undefined ? {} : { beginDate: dateOf(begin) }),
      ...(end === undefined ? {} : { endDate: dateOf(end) }),
      ...(scheduleOid === undefined ? {} : { schedule: schedule ?? { oid: scheduleOid } }),
    };
    const { output, blocks } = shapeOutput(ctx, {
      summary: [
        'Sprint ',
        untrusted(sprint.name),
        `: ${timing ?? 'dates unknown'}, ${total.itemCount} item${total.itemCount === 1 ? '' : 's'}, ${total.estimate === undefined ? 'no estimates' : `${done.estimate ?? (done.itemCount === 0 ? 0 : 'none estimated')} of ${total.estimate} estimate done`}${total.unestimatedItems > 0 ? ` (${total.unestimatedItems} unestimated)` : ''}${committed?.estimate === undefined ? '' : `, ${committed.estimate} committed at the start`}.`,
      ],
      notes,
      blocks: [
        { title: 'Status categories', source: 'status categories', rows: byStatusCategory },
        ...(burndown.length === 0
          ? []
          : [{ title: 'Burndown (remaining estimate, UTC)', source: 'burndown', rows: burndown }]),
        {
          title: 'Items',
          source: 'sprint items',
          rows: itemRows.slice(0, ITEM_LIST_CAP),
          columns: ['number', 'assetType', 'oid', 'status', 'category', 'estimate', 'name'],
        },
      ],
      partial: partial || listCut,
      caps: { maxRows: ITEM_LIST_CAP },
      structured: {
        sprint,
        basis,
        totals: {
          itemCount: total.itemCount,
          ...(total.estimate === undefined ? {} : { estimate: total.estimate }),
          ...(done.estimate === undefined ? {} : { done: done.estimate }),
          ...(open.estimate === undefined ? {} : { remaining: open.estimate }),
          unestimatedItems: total.unestimatedItems,
          unknownCategoryItems: unknownItems,
        },
        byStatusCategory,
        ...(listCut ? { truncated: true } : {}),
        ...(timing === 'future' ? { planned: total } : {}),
        ...(committed === undefined ? {} : { committed }),
        ...(scopeChange === undefined ? {} : { scopeChange }),
        ...(carryOver === undefined ? {} : { carryOver }),
        ...(burndown.length === 0 ? {} : { burndown }),
      },
      ...(input.format === undefined ? {} : { format: input.format }),
    });
    const itemsBlock = blocks[burndown.length === 0 ? 1 : 2];
    return {
      ...output,
      structured: {
        ...(output.structured as Record<string, unknown>),
        items: (itemsBlock?.rows ?? []) as Array<{ oid: string }>,
      },
    };
  },
});
