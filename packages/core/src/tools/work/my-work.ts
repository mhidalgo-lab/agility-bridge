// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { capBudget } from '../../context.ts';
import { AbError, ErrorCode } from '../../errors.ts';
import { resolveMember } from '../../identity/resolve.ts';
import { shapeList, untrusted } from '../../output/result.ts';
import { cursorBinding, decodeCursor, encodeCursor } from '../../query/cursor.ts';
import { invalid } from '../../query/limits.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { cursorArg, formatArg, includeClosedArg, limitArg, listOutput } from '../common.ts';
import { identityFor, WORK_ITEM_TYPES, workItem, workItemFields } from './items.ts';
import { idOf, multiPage, offsetsAfter, type TypedRow } from './multi.ts';
import { readableWorkTypes } from './search.ts';

const NAME = 'list_my_work';
const COST = 20;

const key = (r: TypedRow, field: string) => String(r.row[field] ?? '￿');
const bySprintAndStatus = (a: TypedRow, b: TypedRow) =>
  key(a, 'Timebox.Name').localeCompare(key(b, 'Timebox.Name')) ||
  key(a, 'Status.Name').localeCompare(key(b, 'Status.Name')) ||
  idOf(a.row) - idOf(b.row);

export const listMyWork: ToolDefinition = defineTool({
  name: NAME,
  title: 'List my work',
  description:
    'List the open backlog items, defects, tasks and tests owned by the token’s member (or another member) within the workspace, ordered and grouped by sprint and status. Paged: pass nextCursor back as cursor. A cold call can make up to 20 Agility requests.',
  kind: 'read',
  group: 'work',
  // Capped at run time: member resolution, metadata for the four types and their relations, one page.
  cost: COST,
  inputSchema: z.object({
    member: z
      .string()
      .min(1)
      .max(200)
      .default('me')
      .describe('The owner: me, a username, a name or Member:<id>.'),
    include_closed: includeClosedArg,
    limit: limitArg,
    cursor: cursorArg,
    format: formatArg,
  }),
  outputSchema: listOutput(z.looseObject({ assetType: z.string(), oid: z.string() })),
  handler: async (input, outer) => {
    const ctx = { ...outer, budget: capBudget(outer.budget, COST) };
    const types = readableWorkTypes(ctx, WORK_ITEM_TYPES);
    if (types.length === 0)
      throw new AbError(ErrorCode.AuthForbidden, 'No work-item type is allowed in this workspace.');
    const limit = input.limit ?? ctx.limits.defaultRows;
    if (limit > ctx.limits.maxRows)
      throw invalid(`limit is at most ${ctx.limits.maxRows} in this workspace.`);
    const member = await resolveMember(ctx, input.member ?? 'me');
    const binding = await cursorBinding(ctx, NAME, {
      member: member.oid,
      includeClosed: input.include_closed === true,
      types,
    });
    const offsets =
      input.cursor === undefined ? {} : ((await decodeCursor(ctx, input.cursor, binding)).offsets ?? {});
    const identity = new Map<string, string[]>();
    const queries = [];
    for (const type of types) {
      identity.set(type, await identityFor(type, ctx));
      queries.push({
        type,
        input: {
          assetType: type,
          fields: await workItemFields(ctx, type),
          filters: [{ field: 'Owners', op: 'eq' as const, value: member.oid }],
          sort: [{ field: 'Timebox.Name' }, { field: 'Status.Name' }],
          includeClosed: input.include_closed === true,
        },
      });
    }
    const page = await multiPage(
      ctx,
      queries,
      limit,
      offsets,
      bySprintAndStatus,
      (t) => identity.get(t) ?? [],
    );
    const items = page.rows.map((r) => workItem(r.type, r.row));
    const groups = new Map<string, { sprint?: string; status?: string; items: number }>();
    for (const i of items) {
      const sprint = (i['sprint'] as { name?: string } | undefined)?.name;
      const status = i['status'] as string | undefined;
      const k = `${sprint ?? ''}\u0000${status ?? ''}`;
      const g = groups.get(k) ?? {
        ...(sprint === undefined ? {} : { sprint }),
        ...(status === undefined ? {} : { status }),
        items: 0,
      };
      g.items++;
      groups.set(k, g);
    }
    const out = shapeList(ctx, {
      summary: [
        `${items.length} open work item${items.length === 1 ? '' : 's'} owned by `,
        untrusted(member.name),
        ', by sprint and status.',
      ],
      source: 'work items',
      rows: items,
      columns: [
        'sprint',
        'status',
        'number',
        'assetType',
        'oid',
        'state',
        'project',
        'name',
        'estimate',
        'toDoHours',
      ],
      hasMore: page.hasMore,
      cursorFor: (shown) => encodeCursor(binding, { offset: 0, offsets: offsetsAfter(offsets, page, shown) }),
      hiddenOutsideScope: page.hidden > 0,
      caps: { maxRows: Math.max(limit, 1) },
      ...(input.format === undefined ? {} : { format: input.format }),
    });
    return {
      ...out,
      structured: {
        ...(out.structured as Record<string, unknown>),
        member: { oid: member.oid, name: member.name },
        groups: [...groups.values()],
      },
    };
  },
});
