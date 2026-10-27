// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { capBudget } from '../../context.ts';
import { resolveAsset, resolveProject, runPage } from '../../identity/resolve.ts';
import { metadataFor } from '../../metadata/service.ts';
import { shapeList } from '../../output/result.ts';
import { compileQuery, type FilterInput } from '../../query/compiler.ts';
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
  projectArg,
  statusArg,
} from '../common.ts';
import { identityFor } from '../work/items.ts';
import { EPIC, epicFields, epicRow, requireReadable } from './epics.ts';

const NAME = 'list_portfolio_items';
const COST = 12;

export const listPortfolioItems: ToolDefinition = defineTool({
  name: NAME,
  title: 'List portfolio items',
  description:
    'List portfolio items (epics) of the workspace’s Agility projects with category (Feature, Initiative, …), status, parent, estimates and how many live children each has; filter by category, project, status, parent epic or name. Sorted by ID or name. Paged: pass nextCursor back as cursor. Cold call: up to 12 Agility requests. get_portfolio_tree has roll-ups.',
  kind: 'read',
  group: 'portfolio',
  // Capped at run time: Epic metadata, project and parent resolution, the project tree, the page.
  cost: COST,
  inputSchema: z.object({
    category: z
      .array(z.string().min(1).max(100))
      .max(10)
      .optional()
      .describe('Category names as configured on the instance (for example Feature).'),
    project: projectArg,
    status: statusArg,
    parent: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('Only direct sub-epics of this epic (number or OID token).'),
    contains: containsArg('portfolio items'),
    include_closed: includeClosedArg,
    sort_by: z.enum(['id', 'name']).default('id').describe('id is cheap and stable.'),
    limit: limitArg,
    cursor: cursorArg,
    format: formatArg,
  }),
  outputSchema: listOutput(z.looseObject({ assetType: z.string(), oid: z.string() })),
  handler: async (input, outer) => {
    const ctx = { ...outer, budget: capBudget(outer.budget, COST) };
    requireReadable(ctx, EPIC);
    const md = metadataFor(ctx);
    const filters: FilterInput[] = [];
    const resolved: Record<string, string> = {};
    if (input.project !== undefined) {
      const project = await resolveProject(ctx, input.project);
      const tree = ctx.projects.includeChildren ? await md.projectTree([project.oid]) : [project.oid];
      filters.push({ field: 'Scope', op: 'in', value: [...tree], trusted: true });
      resolved['project'] = project.oid;
    }
    if (input.parent !== undefined) {
      const parent = await resolveAsset(ctx, input.parent);
      if (parent.assetType !== EPIC)
        throw invalid(
          `${parent.assetType} is not a portfolio item (epic).`,
          'Pass an epic number or OID token.',
        );
      filters.push({ field: 'Super', op: 'eq', value: parent.oid, trusted: true });
      resolved['parent'] = parent.oid;
    }
    if (input.category !== undefined && input.category.length > 0)
      filters.push({ field: 'Category.Name', op: 'in', value: [...input.category] });
    if (input.status !== undefined && input.status.length > 0)
      filters.push({ field: 'Status.Name', op: 'in', value: [...input.status] });
    if (input.contains !== undefined) filters.push({ field: 'Name', op: 'contains', value: input.contains });
    const sortBy = input.sort_by ?? 'id';
    const binding = await cursorBinding(ctx, NAME, {
      resolved,
      category: input.category,
      status: input.status,
      contains: input.contains,
      includeClosed: input.include_closed === true,
      sort: sortBy,
    });
    const offset =
      input.cursor === undefined ? 0 : ((await decodeCursor(ctx, input.cursor, binding)).offset ?? 0);
    const epic = await md.assetType(EPIC);
    const compiled = await compileQuery(
      ctx,
      {
        assetType: EPIC,
        fields: await epicFields(ctx, epic.attributes.has('Subs') ? ['Subs.@Count'] : []),
        filters,
        sort: sortBy === 'name' ? [{ field: 'Name' }] : [],
        includeClosed: input.include_closed === true,
        offset,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
      { identityFields: await identityFor(EPIC, ctx) },
    );
    const page = await runPage(ctx, compiled);
    const items = page.rows.map((r) => {
      const raw = r[compiled.keys['Subs.@Count'] ?? ''];
      const count = raw === undefined || raw === null ? Number.NaN : Number(raw);
      return {
        ...epicRow(r),
        ...(Number.isInteger(count) && count >= 0 ? { childCount: count } : {}),
      };
    });
    return shapeList(ctx, {
      summary: `${items.length} portfolio item${items.length === 1 ? '' : 's'}, sorted by ${sortBy}.`,
      notes: ['childCount counts the live sub-epics and backlog items directly under each item.'],
      source: 'portfolio items',
      rows: items,
      columns: [
        'number',
        'assetType',
        'oid',
        'state',
        'project',
        'category',
        'name',
        'status',
        'parent',
        'childCount',
      ],
      hasMore: page.hasMore,
      cursorFor: (shown) => encodeCursor(binding, { offset: page.next(shown) }),
      hiddenOutsideScope: page.hidden > 0,
      ...(input.format === undefined ? {} : { format: input.format }),
      meta: { queries: [compiled.masked] },
    });
  },
});
