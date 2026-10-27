// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { capBudget, type ToolContext } from '../../context.ts';
import { AbError, ErrorCode } from '../../errors.ts';
import { resolveMember, resolveProject, resolveSprint, resolveTeam } from '../../identity/resolve.ts';
import { metadataFor, type StatusCategory } from '../../metadata/service.ts';
import { shapeList } from '../../output/result.ts';
import type { FilterInput } from '../../query/compiler.ts';
import { cursorBinding, decodeCursor, encodeCursor } from '../../query/cursor.ts';
import { invalid } from '../../query/limits.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import {
  containsArg,
  cursorArg,
  formatArg,
  includeClosedArg,
  limitArg,
  listOutput,
  memberArg,
  projectArg,
  sprintArg,
  statusArg,
  teamArg,
  workItemTypeArg,
} from '../common.ts';
import { identityFor, WORK_ITEM_TYPES, workItem, workItemFields } from './items.ts';
import { idOf, multiPage, offsetsAfter, type TypedRow } from './multi.ts';

const NAME = 'search_work_items';
const COST = 24;

const SORTS = {
  id: {
    fields: [] as { field: string; direction?: 'asc' | 'desc' }[],
    compare: (a: TypedRow, b: TypedRow) => idOf(a.row) - idOf(b.row),
  },
  name: {
    fields: [{ field: 'Name' }],
    compare: (a: TypedRow, b: TypedRow) =>
      String(a.row['Name'] ?? '').localeCompare(String(b.row['Name'] ?? '')) || idOf(a.row) - idOf(b.row),
  },
  recently_changed: {
    // The same attribute the rows select (workItemFields), so the comparator sees the sort key (review M2).
    fields: [{ field: 'ChangeDateUTC', direction: 'desc' as const }],
    compare: (a: TypedRow, b: TypedRow) =>
      String(b.row['ChangeDateUTC'] ?? '').localeCompare(String(a.row['ChangeDateUTC'] ?? '')) ||
      idOf(a.row) - idOf(b.row),
  },
};

/** Workspace types the caller may read, among the work-item types asked for. */
export function readableWorkTypes(ctx: ToolContext, wanted: readonly string[]): string[] {
  return wanted.filter(
    (t) =>
      !ctx.assetTypes.deny.includes(t) &&
      (ctx.assetTypes.allow === undefined || ctx.assetTypes.allow.includes(t)),
  );
}

export interface WorkFilters {
  readonly project?: string | undefined;
  readonly team?: string | undefined;
  readonly sprint?: string | undefined;
  readonly member?: string | undefined;
  readonly status?: readonly string[] | undefined;
  readonly statusCategory?: StatusCategory | undefined;
  readonly contains?: string | undefined;
}

/** Resolves the friendly filters once and returns per-type filters plus notes (types a filter cannot apply to). */
export async function workFilters(
  ctx: ToolContext,
  types: readonly string[],
  f: WorkFilters,
): Promise<{ perType: Map<string, FilterInput[]>; notes: string[]; resolved: Record<string, string> }> {
  const md = metadataFor(ctx);
  const common: FilterInput[] = [];
  const resolved: Record<string, string> = {};
  let projectOid: string | undefined;
  if (f.project !== undefined) {
    const project = await resolveProject(ctx, f.project);
    projectOid = project.oid;
    const tree = ctx.projects.includeChildren ? await md.projectTree([project.oid]) : [project.oid];
    common.push({ field: 'Scope', op: 'in', value: [...tree], trusted: true });
    resolved['project'] = project.oid;
  }
  let teamOid: string | undefined;
  if (f.team !== undefined) {
    teamOid = (await resolveTeam(ctx, f.team)).oid;
    common.push({ field: 'Team', op: 'eq', value: teamOid });
    resolved['team'] = teamOid;
  }
  if (f.sprint !== undefined) {
    const sprint = await resolveSprint(ctx, f.sprint, {
      ...(teamOid === undefined ? {} : { team: teamOid }),
      ...(projectOid === undefined ? {} : { project: projectOid }),
    });
    common.push({ field: 'Timebox', op: 'eq', value: sprint.oid });
    resolved['sprint'] = sprint.oid;
  }
  if (f.member !== undefined) {
    const member = await resolveMember(ctx, f.member);
    common.push({ field: 'Owners', op: 'eq', value: member.oid });
    resolved['member'] = member.oid;
  }
  if (f.contains !== undefined) common.push({ field: 'Name', op: 'contains', value: f.contains });
  if (f.status !== undefined && f.status.length > 0)
    common.push({ field: 'Status.Name', op: 'in', value: [...f.status] });
  const perType = new Map<string, FilterInput[]>();
  const notes: string[] = [];
  for (const type of types) {
    const filters = [...common];
    if (f.statusCategory !== undefined) {
      const oids = (await md.statuses(type)).filter((s) => s.category === f.statusCategory).map((s) => s.oid);
      if (oids.length === 0) {
        notes.push(
          `${type} statuses have no rollup category on this instance, so ${type} items were left out.`,
        );
        continue;
      }
      filters.push({ field: 'Status', op: 'in', value: oids });
    }
    perType.set(type, filters);
  }
  return { perType, notes, resolved };
}

export const searchWorkItems: ToolDefinition = defineTool({
  name: NAME,
  title: 'Search work items',
  description:
    'Find and filter work items (backlog items or stories, defects, tasks and tests) within the workspace by Agility project, team, sprint, owner (member), status, status category or words in the name. Sorting by recent change costs about a second per call. Paged: pass nextCursor back as cursor. Cold call: up to 24 Agility requests.',
  kind: 'read',
  group: 'work',
  // Capped at run time: metadata for the types and their relations, name resolution, the project tree, one page.
  cost: COST,
  inputSchema: z.object({
    asset_type: workItemTypeArg(WORK_ITEM_TYPES),
    project: projectArg,
    team: teamArg,
    sprint: sprintArg,
    member: memberArg,
    status: statusArg,
    status_category: z
      .enum(['not_started', 'in_progress', 'completed'])
      .optional()
      .describe('Rollup category of the status.'),
    contains: containsArg('items'),
    include_closed: includeClosedArg,
    sort_by: z
      .enum(['id', 'name', 'recently_changed'])
      .default('id')
      .describe('recently_changed costs about a second per call.'),
    limit: limitArg,
    cursor: cursorArg,
    format: formatArg,
  }),
  outputSchema: listOutput(z.looseObject({ assetType: z.string(), oid: z.string() })),
  handler: async (input, outer) => {
    const ctx = { ...outer, budget: capBudget(outer.budget, COST) };
    const types = readableWorkTypes(
      ctx,
      input.asset_type === undefined ? WORK_ITEM_TYPES : [input.asset_type],
    );
    if (types.length === 0) {
      throw new AbError(
        ErrorCode.AuthForbidden,
        'None of the requested work-item types is allowed in this workspace.',
      );
    }
    const limit = input.limit ?? ctx.limits.defaultRows;
    if (limit > ctx.limits.maxRows)
      throw invalid(`limit is at most ${ctx.limits.maxRows} in this workspace.`);
    const sort = SORTS[input.sort_by ?? 'id'];
    const { perType, notes, resolved } = await workFilters(ctx, types, {
      project: input.project,
      team: input.team,
      sprint: input.sprint,
      member: input.member,
      status: input.status,
      statusCategory: input.status_category,
      contains: input.contains,
    });
    const binding = await cursorBinding(ctx, NAME, {
      types,
      resolved,
      status: input.status,
      statusCategory: input.status_category,
      contains: input.contains,
      includeClosed: input.include_closed === true,
      sort: input.sort_by ?? 'id',
    });
    const offsets =
      input.cursor === undefined ? {} : ((await decodeCursor(ctx, input.cursor, binding)).offsets ?? {});
    const identity = new Map<string, string[]>();
    const queries = [];
    for (const [type, filters] of perType) {
      identity.set(type, await identityFor(type, ctx));
      queries.push({
        type,
        input: {
          assetType: type,
          fields: await workItemFields(ctx, type),
          filters,
          sort: sort.fields,
          includeClosed: input.include_closed === true,
        },
      });
    }
    const page = await multiPage(ctx, queries, limit, offsets, sort.compare, (t) => identity.get(t) ?? []);
    const items = page.rows.map((r) => workItem(r.type, r.row));
    return shapeList(ctx, {
      summary: `${items.length} work item${items.length === 1 ? '' : 's'} (${types.join(', ')}), sorted by ${input.sort_by ?? 'id'}.`,
      notes,
      source: 'work items',
      rows: items,
      columns: [
        'number',
        'assetType',
        'oid',
        'state',
        'project',
        'name',
        'status',
        'owners',
        'sprint',
        'estimate',
        'toDoHours',
        // The sort key is shown when it is the sort: reports read it (P6-07).
        ...(input.sort_by === 'recently_changed' ? ['changedAt'] : []),
      ],
      hasMore: page.hasMore,
      // Per-type offsets after the rows actually shown, so a cut by the output caps skips nothing.
      cursorFor: (shown) => encodeCursor(binding, { offset: 0, offsets: offsetsAfter(offsets, page, shown) }),
      hiddenOutsideScope: page.hidden > 0,
      caps: { maxRows: Math.max(limit, 1) },
      ...(input.format === undefined ? {} : { format: input.format }),
      meta: { queries: page.compiled.map((c) => c.masked) },
    });
  },
});
