// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { agilityClient } from '../../agility/client.ts';
import { capBudget } from '../../context.ts';
import { AbError } from '../../errors.ts';
import { resolveSprint, resolveTeam, runPage } from '../../identity/resolve.ts';
import { inScope, oidsOf, sanitizeRow } from '../../identity/scope.ts';
import { metadataFor } from '../../metadata/service.ts';
import { shapeList, shapeOutput, untrusted } from '../../output/result.ts';
import { compileQuery } from '../../query/compiler.ts';
import { cursorBinding, decodeCursor, encodeCursor } from '../../query/cursor.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { containsArg, cursorArg, formatArg, limitArg, listOutput, rowOid } from '../common.ts';

const LIST_TEAMS = 'list_teams';

export const listTeams: ToolDefinition = defineTool({
  name: LIST_TEAMS,
  title: 'List teams',
  description:
    'List the teams on the instance by name (teams are not tied to an Agility project); use get_team for a team’s workflow, current sprint and members, and list_sprints for its sprints. Paged: pass nextCursor back as cursor.',
  kind: 'read',
  group: 'planning',
  // Team metadata and the page.
  cost: 2,
  inputSchema: z.object({
    contains: containsArg('teams'),
    limit: limitArg,
    cursor: cursorArg,
    format: formatArg,
  }),
  outputSchema: listOutput(z.looseObject({ assetType: z.string(), oid: z.string(), name: z.string() })),
  handler: async (input, ctx) => {
    const binding = await cursorBinding(ctx, LIST_TEAMS, { contains: input.contains });
    const offset = input.cursor === undefined ? 0 : (await decodeCursor(ctx, input.cursor, binding)).offset;
    const compiled = await compileQuery(
      ctx,
      {
        assetType: 'Team',
        fields: ['Name'],
        filters:
          input.contains === undefined ? [] : [{ field: 'Name', op: 'contains', value: input.contains }],
        sort: [{ field: 'Name' }],
        offset,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
      { allowGlobal: true, identityFields: ['AssetState'] },
    );
    const result = await runPage(ctx, compiled);
    const { rows } = result;
    const items = rows
      .slice(0, compiled.limit)
      .map((r) => ({ assetType: 'Team', oid: rowOid(r), name: r['Name'] }));
    return shapeList(ctx, {
      summary: `${items.length} team${items.length === 1 ? '' : 's'}, sorted by name.`,
      source: 'teams',
      rows: items,
      hasMore: result.hasMore,
      cursorFor: (shown) => encodeCursor(binding, { offset: result.next(shown) }),
      ...(input.format === undefined ? {} : { format: input.format }),
    });
  },
});

const GET_TEAM_COST = 20;
/** Open work items read to derive members; within the default row limit. */
const MAX_ASSIGNMENTS = 100;

export const getTeam: ToolDefinition = defineTool({
  name: 'get_team',
  title: 'Get a team',
  description:
    'Get one team: its own workflow statuses where the instance has them, its current sprint, and its members as derived from assignments (owners of open work items with this team inside the workspace; Agility teams have no roster). Not paged. A cold call can make up to 20 Agility requests.',
  kind: 'read',
  group: 'planning',
  // Capped at run time: team resolution, status lists, the assignment query, current-sprint resolution (cold cache).
  cost: GET_TEAM_COST,
  inputSchema: z.object({
    team: z.string().min(1).max(200).describe('Team name or Team:<id>.'),
    format: formatArg,
  }),
  outputSchema: z.looseObject({
    team: z.looseObject({ oid: z.string(), name: z.string() }),
    members: z.array(z.looseObject({ oid: z.string() })),
    statuses: z.array(z.looseObject({ oid: z.string(), name: z.string() })),
  }),
  handler: async (input, outer) => {
    const ctx = { ...outer, budget: capBudget(outer.budget, GET_TEAM_COST) };
    const md = metadataFor(ctx);
    const team = await resolveTeam(ctx, input.team);
    const notes: string[] = [];
    // Team workflows: entries of the status lists that belong to this team.
    const statuses: Record<string, unknown>[] = [];
    for (const type of ['Story', 'Task']) {
      if ((await md.findAssetType(type)) === undefined) continue;
      for (const s of await md.statuses(type))
        if (s.team === team.oid) statuses.push({ assetType: type, ...s });
    }
    if (statuses.length === 0)
      notes.push('This team has no workflow of its own: it uses the instance’s statuses.');
    // Members from assignments: owners of open work items of this team in the workspace.
    const compiled = await compileQuery(
      ctx,
      {
        assetType: 'PrimaryWorkitem',
        fields: ['Owners', 'Owners.Name'],
        filters: [{ field: 'Team', op: 'eq', value: team.oid }],
        limit: MAX_ASSIGNMENTS,
      },
      { allowAbstract: true },
    );
    const res = await agilityClient(ctx).query<unknown[]>([compiled.body]);
    const set = Array.isArray(res.data?.[0]) ? (res.data[0] as Array<Record<string, unknown>>) : [];
    const rows = set.filter((r) => inScope(ctx, compiled, r));
    for (const r of rows) sanitizeRow(ctx, compiled, r);
    const members = new Map<string, { oid: string; name?: string; openItems: number }>();
    for (const r of rows.slice(0, MAX_ASSIGNMENTS)) {
      const oids = oidsOf(r['Owners']);
      const names = Array.isArray(r['Owners.Name']) ? (r['Owners.Name'] as unknown[]) : [];
      for (const [i, oid] of oids.entries()) {
        const m = members.get(oid) ?? {
          oid,
          ...(typeof names[i] === 'string' ? { name: names[i] as string } : {}),
          openItems: 0,
        };
        m.openItems++;
        members.set(oid, m);
      }
    }
    let partial = false;
    if (rows.length > MAX_ASSIGNMENTS) {
      partial = true;
      notes.push(`Members come from the first ${MAX_ASSIGNMENTS} open work items of the team.`);
    }
    notes.push(
      'Members are derived from assignments (owners of open backlog items and defects with this team), not a roster.',
    );
    let current: { oid: string; name: string } | undefined;
    try {
      const sprint = await resolveSprint(ctx, 'current', { team: team.oid });
      current = { oid: sprint.oid, name: sprint.name };
    } catch (error) {
      if (!(error instanceof AbError) || (error.code !== 'AB_NOT_FOUND' && error.code !== 'AB_AMBIGUOUS'))
        throw error;
      notes.push(
        error.code === 'AB_NOT_FOUND'
          ? 'The team has no current sprint.'
          : 'Several current sprints have work of this team; see list_sprints.',
      );
    }
    const memberRows = [...members.values()].sort(
      (a, b) => b.openItems - a.openItems || a.oid.localeCompare(b.oid),
    );
    const { output, blocks } = shapeOutput(ctx, {
      summary: [
        'Team ',
        untrusted(team.name),
        `: ${memberRows.length} member${memberRows.length === 1 ? '' : 's'} by assignment.`,
      ],
      notes,
      blocks: [
        {
          title: 'Current sprint',
          source: 'sprint',
          rows: current === undefined ? [] : [{ assetType: 'Timebox', ...current }],
        },
        { title: 'Members (derived from assignments)', source: 'team members', rows: memberRows },
        {
          title: 'Team workflow statuses',
          source: 'statuses',
          rows: statuses,
          columns: ['assetType', 'oid', 'name', 'category', 'inactive'],
        },
      ],
      partial,
      caps: { maxRows: MAX_ASSIGNMENTS },
      ...(input.format === undefined ? {} : { format: input.format }),
    });
    return {
      ...output,
      structured: {
        ...(output.structured as Record<string, unknown>),
        team: { oid: team.oid, name: team.name },
        ...(blocks[0]?.rows[0] === undefined ? {} : { currentSprint: blocks[0].rows[0] }),
        members: (blocks[1]?.rows ?? []) as Array<{ oid: string }>,
        membersSource: 'assignments',
        statuses: (blocks[2]?.rows ?? []) as Array<{ oid: string; name: string }>,
      },
    };
  },
});
