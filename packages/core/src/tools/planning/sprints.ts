// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { capBudget } from '../../context.ts';
import { resolveProject, resolveTeam, runPage } from '../../identity/resolve.ts';
import { oidsOf } from '../../identity/scope.ts';
import { assetState, shapeList } from '../../output/result.ts';
import { utcIso } from '../../output/text.ts';
import { compileQuery, type FilterInput } from '../../query/compiler.ts';
import { bindFixed, cursorBinding, decodeCursor, encodeCursor } from '../../query/cursor.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { cursorArg, formatArg, limitArg, listOutput, projectArg, rowOid, teamArg } from '../common.ts';

const NAME = 'list_sprints';
const COST = 10;

export const listSprints: ToolDefinition = defineTool({
  name: NAME,
  title: 'List sprints',
  description:
    'List the sprints of the workspace’s Agility projects or of a team with begin and end dates (UTC) and whether each is past, current or future (which one is current, which starts next); newest first. Paged: pass nextCursor back as cursor. Cold call: up to 10 Agility requests.',
  kind: 'read',
  group: 'planning',
  // Capped at run time: Timebox and related metadata, team or project resolution, the project tree, the page.
  cost: COST,
  inputSchema: z.object({
    team: teamArg,
    project: projectArg,
    timing: z
      .enum(['current', 'past', 'future', 'all'])
      .default('all')
      .describe('By dates relative to now (UTC).'),
    limit: limitArg,
    cursor: cursorArg,
    format: formatArg,
  }),
  outputSchema: listOutput(z.looseObject({ assetType: z.string(), oid: z.string(), name: z.string() })),
  handler: async (input, outer) => {
    const ctx = { ...outer, budget: capBudget(outer.budget, COST) };
    // Timing is evaluated against the first page's "now", kept in the cursor, so a sprint that ends while the caller
    // pages neither moves between pages nor is skipped (P1-18).
    const binding = await cursorBinding(ctx, NAME, {
      team: input.team,
      project: input.project,
      timing: input.timing ?? 'all',
    });
    const state = input.cursor === undefined ? undefined : await decodeCursor(ctx, input.cursor, binding);
    const now = state?.now ?? new Date(ctx.clock.now()).toISOString();
    const sealed = await bindFixed(binding, { now });
    const filters: FilterInput[] = [];
    const resolved: Record<string, string> = {};
    if (input.team !== undefined) {
      resolved['team'] = (await resolveTeam(ctx, input.team)).oid;
      filters.push({ field: 'Workitems.Team', op: 'eq', value: resolved['team'], trusted: true });
    }
    if (input.project !== undefined) {
      resolved['project'] = (await resolveProject(ctx, input.project)).oid;
      filters.push({
        field: 'Schedule.ScheduledScopes',
        op: 'eq',
        value: resolved['project'],
        trusted: true,
      });
    }
    const timing = input.timing ?? 'all';
    if (timing === 'current')
      filters.push({ field: 'BeginDate', op: 'le', value: now }, { field: 'EndDate', op: 'gt', value: now });
    if (timing === 'past') filters.push({ field: 'EndDate', op: 'le', value: now });
    if (timing === 'future') filters.push({ field: 'BeginDate', op: 'gt', value: now });
    const offset = state?.offset ?? 0;
    const compiled = await compileQuery(ctx, {
      assetType: 'Timebox',
      fields: ['Name', 'BeginDate', 'EndDate', 'AssetState', 'Schedule', 'Schedule.Name'],
      filters,
      sort: [{ field: 'BeginDate', direction: 'desc' }],
      includeClosed: true,
      offset,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    const result = await runPage(ctx, compiled);
    const { rows, hidden } = result;
    const items = rows.map((r) => {
      const begin =
        typeof r['BeginDate'] === 'string' ? (utcIso(r['BeginDate']) ?? r['BeginDate']) : undefined;
      const end = typeof r['EndDate'] === 'string' ? (utcIso(r['EndDate']) ?? r['EndDate']) : undefined;
      const when =
        begin !== undefined && end !== undefined
          ? end <= now
            ? 'past'
            : begin > now
              ? 'future'
              : 'current'
          : undefined;
      const schedule = oidsOf(r['Schedule'])[0];
      return {
        assetType: 'Timebox',
        oid: rowOid(r),
        name: r['Name'],
        state: assetState(r['AssetState']),
        ...(begin === undefined ? {} : { beginDate: begin }),
        ...(end === undefined ? {} : { endDate: end }),
        ...(when === undefined ? {} : { timing: when }),
        ...(schedule === undefined
          ? {}
          : {
              schedule: {
                oid: schedule,
                ...(typeof r['Schedule.Name'] === 'string' ? { name: r['Schedule.Name'] } : {}),
              },
            }),
      };
    });
    return shapeList(ctx, {
      summary: `${items.length} sprint${items.length === 1 ? '' : 's'}${timing === 'all' ? '' : ` (${timing})`}, newest first.`,
      notes:
        timing === 'current' && items.length > 1
          ? ['Several sprints are current: the workspace has more than one schedule.']
          : [],
      source: 'sprints',
      rows: items,
      columns: ['assetType', 'oid', 'state', 'name', 'timing', 'beginDate', 'endDate', 'schedule'],
      hasMore: result.hasMore,
      cursorFor: (shown) => encodeCursor(sealed, { offset: result.next(shown), now }),
      hiddenOutsideScope: hidden > 0,
      ...(input.format === undefined ? {} : { format: input.format }),
    });
  },
});
