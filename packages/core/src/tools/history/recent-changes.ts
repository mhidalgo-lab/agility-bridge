// SPDX-License-Identifier: Apache-2.0
// list_recent_changes (P6-05, L-060): work items of an Agility project, a team or the workspace whose latest version
// changed inside a bounded window. One `query.v1` with bound `ChangeDate` filters; it says which items changed, and
// get_asset_history says what changed on one of them. The activity stream is never read (L-146).
import { z } from 'zod';
import { capBudget, type ToolContext } from '../../context.ts';
import { AbError, ErrorCode } from '../../errors.ts';
import { metadataFor } from '../../metadata/service.ts';
import { shapeList } from '../../output/result.ts';
import { utcIso } from '../../output/text.ts';
import type { FilterInput } from '../../query/compiler.ts';
import { checkCursorShape, cursorBinding, decodeCursor, encodeCursor } from '../../query/cursor.ts';
import { invalid } from '../../query/limits.ts';
import { parseTimeRange } from '../../query/time.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import {
  changedItemTypeArg,
  cursorArg,
  formatArg,
  includeClosedArg,
  limitArg,
  listOutput,
  projectArg,
  teamArg,
  timeRangeArg,
} from '../common.ts';
import { EPIC, epicFields, epicRow } from '../portfolio/epics.ts';
import { identityFor, WORK_ITEM_TYPES, workItem, workItemFields } from '../work/items.ts';
import { idOf, multiPage, offsetsAfter, type TypedRow } from '../work/multi.ts';
import { readableWorkTypes, workFilters } from '../work/search.ts';

const NAME = 'list_recent_changes';
const COST = 24;
/** Work-item types plus epics (portfolio items, D-91): epics keep their own row and field set. */
const CHANGE_TYPES = [...WORK_ITEM_TYPES, EPIC] as const;
const DEFAULT_WINDOW = 'last 7 days';

export const listRecentChanges: ToolDefinition = defineTool({
  name: NAME,
  title: 'List recent changes',
  description:
    'List work items (backlog items, defects, tasks, tests) and epics changed inside a bounded time_range in an Agility project, a team or the whole workspace, newest first, with who changed them; get_asset_history shows what changed. Sorts by change date, about a second per call. Paged: pass nextCursor back as cursor. Cold call: up to 24 Agility requests.',
  kind: 'read',
  group: 'history',
  // Capped at run time: metadata for the types, name resolution, the project tree, one page of one batched request.
  cost: COST,
  inputSchema: z.object({
    project: projectArg,
    team: teamArg,
    asset_type: changedItemTypeArg(CHANGE_TYPES),
    time_range: timeRangeArg(DEFAULT_WINDOW),
    include_closed: includeClosedArg,
    limit: limitArg,
    cursor: cursorArg,
    format: formatArg,
  }),
  outputSchema: listOutput(z.looseObject({ assetType: z.string(), oid: z.string() })).and(
    z.looseObject({
      window: z.looseObject({ since: z.string(), until: z.string() }),
    }),
  ),
  handler: async (input, outer) => {
    const ctx: ToolContext = {
      ...outer,
      budget: capBudget(outer.budget, COST),
    };
    checkCursorShape(ctx, input.cursor);
    // The window and the page size are validated before any request (L-060).
    const window = parseTimeRange(
      input.time_range ?? DEFAULT_WINDOW,
      ctx.clock.now(),
      ctx.limits.maxTimeRangeDays,
    );
    const limit = input.limit ?? ctx.limits.defaultRows;
    if (limit > ctx.limits.maxRows)
      throw invalid(`limit is at most ${ctx.limits.maxRows} in this workspace.`);
    const types = readableWorkTypes(ctx, input.asset_type === undefined ? CHANGE_TYPES : [input.asset_type]);
    if (types.length === 0) {
      throw new AbError(
        ErrorCode.AuthForbidden,
        'None of the requested work-item types is allowed in this workspace.',
      );
    }
    const { perType, notes, resolved } = await workFilters(ctx, types, {
      project: input.project,
      team: input.team,
    });
    // Not every instance gives epics a team: leave them out of a team view instead of failing the whole call.
    if (
      input.team !== undefined &&
      perType.has(EPIC) &&
      !(await metadataFor(ctx).assetType(EPIC)).attributes.has('Team')
    ) {
      perType.delete(EPIC);
      notes.push('Epics have no team on this instance, so they were left out of the team view.');
    }
    const binding = await cursorBinding(ctx, NAME, {
      types,
      resolved,
      since: window.since,
      until: window.until,
      includeClosed: input.include_closed === true,
    });
    const offsets =
      input.cursor === undefined ? {} : ((await decodeCursor(ctx, input.cursor, binding)).offsets ?? {});
    const md = metadataFor(ctx);
    const identity = new Map<string, string[]>();
    const changedField = new Map<string, string>();
    const queries = [];
    await md.prefetch(perType.keys());
    for (const [type, common] of perType) {
      identity.set(type, await identityFor(type, ctx));
      const meta = await md.assetType(type);
      const field = meta.attributes.has('ChangeDateUTC') ? 'ChangeDateUTC' : 'ChangeDate';
      changedField.set(type, field);
      const filters: FilterInput[] = [
        ...common,
        { field, op: 'ge', value: window.since },
        { field, op: 'lt', value: window.until },
      ];
      queries.push({
        type,
        input: {
          assetType: type,
          fields: [
            ...new Set([
              ...(type === EPIC ? await epicFields(ctx) : await workItemFields(ctx, type)),
              ...(meta.attributes.has('ChangedBy') ? ['ChangedBy.Name'] : []),
            ]),
          ],
          filters,
          sort: [{ field, direction: 'desc' as const }],
          includeClosed: input.include_closed === true,
        },
      });
    }
    const compare = (a: TypedRow, b: TypedRow): number => {
      // As instants, not text: stamps with a different number of fractional digits do not sort by characters.
      const key = (r: TypedRow): number => {
        const f = changedField.get(r.type) ?? 'ChangeDate';
        const iso = utcIso(String(r.row[f] ?? ''));
        const t = iso === undefined ? Number.NaN : Date.parse(iso);
        return Number.isNaN(t) ? 0 : t;
      };
      return key(b) - key(a) || idOf(a.row) - idOf(b.row);
    };
    const page = await multiPage(ctx, queries, limit, offsets, compare, (t) => identity.get(t) ?? []);
    const items = page.rows.map((r) => {
      const by = r.row['ChangedBy.Name'];
      return {
        ...(r.type === EPIC ? epicRow(r.row) : workItem(r.type, r.row)),
        ...(typeof by === 'string' && by !== '' ? { changedBy: by } : {}),
      };
    });
    const out = shapeList(ctx, {
      summary: `${items.length} item${items.length === 1 ? '' : 's'} changed between ${window.since} and ${window.until} (${types.join(', ')}), newest change first.`,
      notes: [
        ...notes,
        'The time shown is the item’s latest change; use get_asset_history for what changed on one item.',
      ],
      source: 'recently changed work items and epics',
      rows: items,
      columns: [
        'number',
        'assetType',
        'oid',
        'state',
        'project',
        'name',
        'category',
        'status',
        'owners',
        'sprint',
        'changedAt',
        'changedBy',
      ],
      hasMore: page.hasMore,
      cursorFor: (shown) =>
        encodeCursor(binding, {
          offset: 0,
          offsets: offsetsAfter(offsets, page, shown),
        }),
      hiddenOutsideScope: page.hidden > 0,
      caps: { maxRows: Math.max(limit, 1) },
      ...(input.format === undefined ? {} : { format: input.format }),
      meta: { queries: page.compiled.map((c) => c.masked), window },
    });
    return {
      ...out,
      structured: {
        ...(out.structured as {
          items: Array<{ assetType: string; oid: string }>;
        }),
        window: { ...window },
      },
    };
  },
});
