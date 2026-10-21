// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { agilityClient } from '../../agility/client.ts';
import { capBudget } from '../../context.ts';
import { runPage } from '../../identity/resolve.ts';
import { oidsOf } from '../../identity/scope.ts';
import { metadataFor } from '../../metadata/service.ts';
import { assetState, shapeList } from '../../output/result.ts';
import { compileQuery, type FilterInput } from '../../query/compiler.ts';
import { cursorBinding, decodeCursor, encodeCursor } from '../../query/cursor.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { containsArg, cursorArg, formatArg, limitArg, listOutput, rowOid } from '../common.ts';

const NAME = 'list_members';
const COST = 6;
const MAX_PROJECT_MEMBERS = 2_000;

export const listMembers: ToolDefinition = defineTool({
  name: NAME,
  title: 'List members',
  description:
    'Find members by name or username among the members of the workspace’s Agility projects (all members when the workspace has no project restriction). Emails only when the workspace enables them. Paged: pass nextCursor back as cursor.',
  kind: 'read',
  group: 'people',
  // Capped at run time: Member and Scope metadata, the project tree, the project membership and the page.
  cost: COST,
  inputSchema: z.object({
    contains: containsArg('members'),
    limit: limitArg,
    cursor: cursorArg,
    format: formatArg,
  }),
  outputSchema: listOutput(z.looseObject({ assetType: z.string(), oid: z.string(), name: z.string() })),
  handler: async (input, outer) => {
    const ctx = { ...outer, budget: capBudget(outer.budget, COST) };
    const filters: FilterInput[] = [];
    const notes: string[] = [];
    if (ctx.projects.allowed.length > 0) {
      // Members of the allowed projects (and sub-projects), through Scope.Members.
      const tree = ctx.projects.includeChildren
        ? await metadataFor(ctx).projectTree(ctx.projects.allowed)
        : [...ctx.projects.allowed];
      const res = await agilityClient(ctx).query<unknown[][]>({
        from: 'Scope',
        select: ['Members'],
        filter: ['ID=$ab_scope'],
        with: { $ab_scope: tree },
        sort: ['ID'],
        page: { start: 0, size: tree.length },
      });
      const members = new Set<string>();
      for (const r of (Array.isArray(res.data?.[0]) ? res.data[0] : []) as Array<Record<string, unknown>>) {
        for (const m of oidsOf(r['Members'])) members.add(m);
      }
      if (members.size > MAX_PROJECT_MEMBERS) {
        notes.push(`Only the first ${MAX_PROJECT_MEMBERS} project members are searched.`);
      }
      if (members.size === 0) {
        return shapeList(ctx, {
          summary: '0 members: the workspace’s Agility projects list no members.',
          source: 'members',
          rows: [],
        });
      }
      filters.push({
        field: 'ID',
        op: 'in',
        value: [...members].sort().slice(0, MAX_PROJECT_MEMBERS),
        trusted: true,
      });
    }
    if (input.contains !== undefined) filters.push({ field: 'Name', op: 'contains', value: input.contains });
    const binding = await cursorBinding(ctx, NAME, { contains: input.contains });
    const offset = input.cursor === undefined ? 0 : decodeCursor(input.cursor, binding).offset;
    const emails = ctx.limits.memberEmails;
    const compiled = await compileQuery(
      ctx,
      {
        assetType: 'Member',
        fields: ['Name', 'Username', ...(emails ? ['Email'] : [])],
        filters,
        sort: [{ field: 'Name' }],
        offset,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
      { allowGlobal: true, identityFields: ['AssetState'] },
    );
    const result = await runPage(ctx, compiled);
    const { rows } = result;
    const items = rows.map((r) => ({
      assetType: 'Member',
      oid: rowOid(r),
      name: r['Name'],
      ...(typeof r['Username'] === 'string' ? { username: r['Username'] } : {}),
      state: assetState(r['AssetState'], 'Member'),
      ...(emails && typeof r['Email'] === 'string' ? { email: r['Email'] } : {}),
    }));
    return shapeList(ctx, {
      summary: `${items.length} member${items.length === 1 ? '' : 's'}${ctx.projects.allowed.length > 0 ? ' of the workspace’s Agility projects' : ''}, sorted by name.`,
      notes,
      source: 'members',
      rows: items,
      columns: ['assetType', 'oid', 'state', 'name', 'username', ...(emails ? ['email'] : [])],
      hasMore: result.hasMore,
      cursorFor: (shown) => encodeCursor(binding, { offset: result.next(shown) }),
      ...(input.format === undefined ? {} : { format: input.format }),
    });
  },
});
