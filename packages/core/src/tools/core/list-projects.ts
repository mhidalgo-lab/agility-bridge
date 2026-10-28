// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { runPage } from '../../identity/resolve.ts';
import { assetState, shapeList } from '../../output/result.ts';
import { compileQuery } from '../../query/compiler.ts';
import { checkCursorShape, cursorBinding, decodeCursor, encodeCursor } from '../../query/cursor.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import {
  containsArg,
  cursorArg,
  formatArg,
  includeClosedArg,
  limitArg,
  listOutput,
  ref,
  rowOid,
} from '../common.ts';

const NAME = 'list_projects';

export const listProjects: ToolDefinition = defineTool({
  name: NAME,
  title: 'List Agility projects',
  description:
    'List the Agility projects this workspace allows (Scope), sub-projects included when the workspace includes them, with parent, state and schedule. Paged: pass nextCursor back as cursor.',
  kind: 'read',
  group: 'core',
  // Scope, Schedule and BaseAsset metadata (the related-asset checks), the project tree and the page (cold cache).
  cost: 5,
  inputSchema: z.object({
    contains: containsArg('projects'),
    include_closed: includeClosedArg,
    limit: limitArg,
    cursor: cursorArg,
    format: formatArg,
  }),
  outputSchema: listOutput(
    z.looseObject({ assetType: z.string(), oid: z.string(), name: z.string(), state: z.string() }),
  ),
  handler: async (input, ctx) => {
    checkCursorShape(ctx, input.cursor);
    const binding = await cursorBinding(ctx, NAME, {
      contains: input.contains,
      includeClosed: input.include_closed === true,
    });
    const offset = input.cursor === undefined ? 0 : (await decodeCursor(ctx, input.cursor, binding)).offset;
    const compiled = await compileQuery(ctx, {
      assetType: 'Scope',
      fields: ['Name', 'AssetState', 'Parent', 'Parent.Name', 'Schedule', 'Schedule.Name'],
      filters: input.contains === undefined ? [] : [{ field: 'Name', op: 'contains', value: input.contains }],
      sort: [{ field: 'Name' }],
      includeClosed: input.include_closed === true,
      offset,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    const result = await runPage(ctx, compiled);
    const { rows, hidden } = result;
    const page = rows;
    const items = page.map((r) => {
      const parent = ref(r, 'Parent');
      const schedule = ref(r, 'Schedule');
      return {
        assetType: 'Scope',
        oid: rowOid(r),
        name: r['Name'],
        state: assetState(r['AssetState']),
        ...(parent === undefined ? {} : { parent }),
        ...(schedule === undefined ? {} : { schedule }),
      };
    });
    return shapeList(ctx, {
      summary: `${items.length} Agility project${items.length === 1 ? '' : 's'}${offset > 0 ? ` (from row ${offset + 1})` : ''}, sorted by name.`,
      source: 'Agility projects',
      rows: items,
      columns: ['assetType', 'oid', 'state', 'name', 'parent', 'schedule'],
      hasMore: result.hasMore,
      cursorFor: (shown) => encodeCursor(binding, { offset: result.next(shown) }),
      hiddenOutsideScope: hidden > 0,
      ...(input.format === undefined ? {} : { format: input.format }),
      meta: { query: compiled.masked },
    });
  },
});
