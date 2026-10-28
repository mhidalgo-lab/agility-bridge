// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { capBudget } from '../../context.ts';
import { resolveProject, runPage } from '../../identity/resolve.ts';
import { metadataFor } from '../../metadata/service.ts';
import { shapeList } from '../../output/result.ts';
import { compileQuery, FILTER_OPS, type FilterInput } from '../../query/compiler.ts';
import { cursorBinding, decodeCursor, encodeCursor } from '../../query/cursor.ts';
import { invalid } from '../../query/limits.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import {
  assetTypeArg,
  cursorArg,
  formatArg,
  includeClosedArg,
  limitArg,
  listOutput,
  minimalOutputArg,
  projectArg,
} from '../common.ts';
import { fieldInfo, IDENTITY_FIELDS, localTimeNote, toItem } from './rows.ts';

const NAME = 'query_assets';
const COST = 12;

const filterFields = {
  field: z.string().min(1).max(200),
  op: z.enum(FILTER_OPS as unknown as [FilterInput['op'], ...FilterInput['op'][]]),
};
const filterValue = z.union([
  z.string().max(1_000),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string().max(1_000), z.number()])).max(50),
]);
export const filterSchema: z.ZodType<FilterInput> = z.object({
  ...filterFields,
  field: filterFields.field.describe('Attribute path, e.g. Status.Name, Owners.Name, Estimate.'),
  value: filterValue
    .optional()
    .describe('A scalar (no commas) or, for "in", an array. Omit for is_set and is_not_set.'),
}) as unknown as z.ZodType<FilterInput>;
/** The same filter inside `any_of`: the description is spent once, on `filters`. */
const groupFilterSchema = z.object({
  ...filterFields,
  value: filterValue.optional(),
}) as unknown as z.ZodType<FilterInput>;

/** Path of the Agility project for `project` narrowing, per scope strategy. */
function projectPath(kind: string, path?: string): string | undefined {
  if (kind === 'direct' || kind === 'derived') return path;
  if (kind === 'workspace_bounded') return path === 'self' ? 'ID' : 'Schedule.ScheduledScopes';
  return undefined;
}

export const queryAssets: ToolDefinition = defineTool({
  name: NAME,
  title: 'Query assets',
  description:
    'Query any asset type this workspace allows (stories, defects, tasks, tests, epics, issues, requests, custom fields) with structured filters, fields and sort; values are bound and the workspace scope is enforced. Sorting by ChangeDate costs about a second per call. Paged: pass nextCursor back as cursor. Cold call: up to 12 Agility requests.',
  kind: 'read',
  group: 'query',
  // Capped at run time: metadata for the type and every related type on a cold cache, the project tree, the page.
  cost: COST,
  inputSchema: z.object({
    asset_type: assetTypeArg,
    fields: z
      .array(z.string().min(1).max(200))
      .max(30)
      .optional()
      .describe('Attribute paths to return; the type’s default tier when omitted.'),
    filters: z.array(filterSchema).max(20).optional().describe('ANDed filters: { field, op, value }.'),
    any_of: z
      .array(z.array(groupFilterSchema).min(1).max(10))
      .max(3)
      .optional()
      .describe('OR between groups of filters (same shape as filters), AND inside a group.'),
    project: projectArg,
    include_child_projects: z
      .boolean()
      .optional()
      .describe('With project: include its sub-projects (the workspace setting when omitted).'),
    include_closed: includeClosedArg,
    sort: z
      .array(z.object({ field: z.string().min(1).max(200), direction: z.enum(['asc', 'desc']).optional() }))
      .max(3)
      .optional()
      .describe('Sort fields; ID is the order when omitted and always the last tiebreaker.'),
    as_of: z.string().max(40).optional().describe('ISO 8601 UTC point in time (bounded by the workspace).'),
    minimal_output: minimalOutputArg,
    limit: limitArg,
    cursor: cursorArg,
    format: formatArg,
  }),
  outputSchema: listOutput(z.looseObject({ assetType: z.string(), oid: z.string() })),
  handler: async (input, outer) => {
    const ctx = { ...outer, budget: capBudget(outer.budget, COST) };
    const md = metadataFor(ctx);
    const type = (await md.assetType(input.asset_type)).name;
    // Global types only when the workspace names them in its allow list (ADR-0012).
    const allowGlobal = ctx.assetTypes.allow?.includes(type) === true;
    const filters: FilterInput[] = [...(input.filters ?? [])];
    let projectNote: string | undefined;
    if (input.project !== undefined) {
      const strategy = await md.scopeStrategy(type);
      const path = projectPath(
        strategy.kind,
        strategy.kind === 'workspace_bounded' ? strategy.via : 'path' in strategy ? strategy.path : undefined,
      );
      if (path === undefined)
        throw invalid(`${type} is not tied to an Agility project: project does not apply.`);
      const project = await resolveProject(ctx, input.project);
      const children = input.include_child_projects ?? ctx.projects.includeChildren;
      const tree = children ? await md.projectTree([project.oid]) : [project.oid];
      filters.push({ field: path, op: 'in', value: [...tree], trusted: true });
      projectNote = `Agility project ${project.oid}${children ? ' and its sub-projects' : ''}.`;
    }
    const fields = input.minimal_output === true ? (await md.fieldTiers(type)).minimal : input.fields;
    const normalized = {
      assetType: type,
      fields,
      filters,
      anyOf: input.any_of,
      sort: input.sort,
      asOf: input.as_of,
      includeClosed: input.include_closed === true,
    };
    const binding = await cursorBinding(ctx, NAME, normalized);
    const offset = input.cursor === undefined ? 0 : (await decodeCursor(ctx, input.cursor, binding)).offset;
    const meta = await md.assetType(type);
    const identity = IDENTITY_FIELDS.filter((f) => meta.attributes.has(f.split('.')[0] as string));
    const compiled = await compileQuery(
      ctx,
      {
        assetType: type,
        ...(fields === undefined ? {} : { fields }),
        filters,
        ...(input.any_of === undefined ? {} : { anyOf: input.any_of }),
        ...(input.sort === undefined ? {} : { sort: input.sort }),
        ...(input.as_of === undefined ? {} : { asOf: input.as_of }),
        includeClosed: input.include_closed === true,
        offset,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
      { allowGlobal, identityFields: identity },
    );
    const info = await fieldInfo(ctx, type, compiled.fields);
    const result = await runPage(ctx, compiled);
    const { rows, hidden } = result;
    const items = rows
      .slice(0, compiled.limit)
      .map((r) => toItem(r, type, compiled.fields, info, compiled.keys));
    return shapeList(ctx, {
      summary: `${items.length} ${type} row${items.length === 1 ? '' : 's'}${offset > 0 ? ` from row ${offset + 1}` : ''}, sorted by ${(compiled.body['sort'] as string[]).join(', ')}.`,
      notes: [
        ...(projectNote === undefined ? [] : [`Only ${projectNote}`]),
        ...(localTimeNote(items, info) === undefined ? [] : [localTimeNote(items, info) as string]),
      ],
      source: `${type} rows`,
      rows: items,
      columns: ['number', 'assetType', 'oid', 'state', 'project', ...compiled.fields],
      richText: info.richText,
      hasMore: result.hasMore,
      cursorFor: (shown) => encodeCursor(binding, { offset: result.next(shown) }),
      hiddenOutsideScope: hidden > 0,
      ...(input.format === undefined ? {} : { format: input.format }),
      meta: { query: compiled.masked },
    });
  },
});
