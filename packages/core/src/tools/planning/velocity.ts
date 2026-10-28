// SPDX-License-Identifier: Apache-2.0
// get_velocity (P6-17): the completed estimate of a team's or Agility project's last past sprints, each read as it
// ended (`asof` its end date, one page, bounded history, L-060). A sprint that cannot be read in full is named and left
// out, never estimated (L-033); capacity is not reported (D-83).
import { z } from 'zod';
import { agilityClient } from '../../agility/client.ts';
import { capBudget } from '../../context.ts';
import { AbError, ErrorCode } from '../../errors.ts';
import { resolveProject, resolveTeam, runPage } from '../../identity/resolve.ts';
import { oidsOf } from '../../identity/scope.ts';
import { metadataFor } from '../../metadata/service.ts';
import { shapeOutput } from '../../output/result.ts';
import { type CompiledQuery, compileQuery, type FilterInput } from '../../query/compiler.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { formatArg, num, projectArg, rowOid, teamArg } from '../common.ts';
import { readableWorkTypes } from '../work/search.ts';
import { instant, keep } from './sprint.ts';

const COST = 16;
const DAY = 86_400_000;
const MAX_SPRINTS = 10;
const DEFAULT_SPRINTS = 6;
/** Rows one batched request may ask for (the response cap, L-279, P6-42). */
const ROWS_PER_REQUEST = 2000;

type Row = Record<string, unknown>;

interface Read {
  readonly oid: string;
  readonly name: string;
  readonly end: number;
  query?: CompiledQuery;
  rows?: Row[];
  skipped?: string;
}

const round = (n: number): number => Math.round(n * 100) / 100;

export const getVelocity: ToolDefinition = defineTool({
  name: 'get_velocity',
  title: 'Get velocity',
  description:
    'Velocity: completed estimate of the last past sprints (at most 10) of a team or Agility project, each read as it ended, and the average over those read in full. Sprints that could not be read are named in notes. No capacity. Not paged. Cold call: up to 16 Agility requests.',
  kind: 'read',
  group: 'planning',
  // Capped at run time: team or project resolution, metadata and status lists, the sprint list, batched sprint reads.
  cost: COST,
  inputSchema: z.object({
    team: teamArg,
    project: projectArg,
    sprints: z
      .number()
      .int()
      .min(1)
      .max(MAX_SPRINTS)
      .default(DEFAULT_SPRINTS)
      .describe('How many past sprints, newest first.'),
    format: formatArg,
  }),
  outputSchema: z.looseObject({
    sprints: z.array(z.looseObject({ oid: z.string() })),
    average: z.number().optional(),
    sprintsCounted: z.number(),
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
    const wanted = input.sprints ?? DEFAULT_SPRINTS;
    const now = ctx.clock.now();
    const notes: string[] = [];
    let partial = false;

    // The past sprints, newest first (the same filters as list_sprints).
    const filters: FilterInput[] = [{ field: 'EndDate', op: 'le', value: new Date(now).toISOString() }];
    if (team !== undefined) filters.push({ field: 'Workitems.Team', op: 'eq', value: team, trusted: true });
    if (project !== undefined)
      filters.push({ field: 'Schedule.ScheduledScopes', op: 'eq', value: project, trusted: true });
    const list = await runPage(
      ctx,
      await compileQuery(ctx, {
        assetType: 'Timebox',
        fields: ['Name', 'BeginDate', 'EndDate'],
        filters,
        sort: [{ field: 'EndDate', direction: 'desc' }],
        includeClosed: true,
        limit: wanted,
      }),
    );
    if (list.hidden > 0) partial = true;

    const statusCategory = new Map<string, string | undefined>();
    await md.prefetch(types);
    for (const type of types)
      for (const st of await md.statuses(type)) statusCategory.set(st.oid, st.category);
    const itemMeta = await md.assetType('PrimaryWorkitem');
    const has = (a: string) => itemMeta.attributes.has(a);
    const fields = ['AssetType', 'Status', 'Estimate'].filter(has);
    if (!has('Estimate'))
      notes.push('This instance has no estimate on backlog items: no estimates are reported.');
    if (team !== undefined && !has('Team'))
      notes.push('Backlog items have no team here: the sprints are read for all their items.');
    const pageSize = ctx.limits.maxRows;

    const reads: Read[] = [];
    for (const r of list.rows) {
      const end = instant(r['EndDate']);
      const read: Read = { oid: rowOid(r), name: String(r['Name'] ?? rowOid(r)), end: end ?? 0 };
      if (end === undefined) read.skipped = 'it has no usable end date';
      else if (end > now) read.skipped = 'it has not ended';
      else if ((now - end) / DAY > ctx.limits.maxAsOfAgeDays)
        read.skipped = `it ended more than ${ctx.limits.maxAsOfAgeDays} days ago (the history limit)`;
      else
        read.query = await compileQuery(
          ctx,
          {
            assetType: 'PrimaryWorkitem',
            fields,
            filters: [
              { field: 'Timebox', op: 'eq', value: read.oid, trusted: true },
              ...(team !== undefined && has('Team')
                ? [{ field: 'Team', op: 'eq' as const, value: team, trusted: true }]
                : []),
            ],
            includeClosed: true,
            limit: pageSize,
            asOf: new Date(end).toISOString(),
          },
          { allowAbstract: true },
        );
      reads.push(read);
    }

    // One page of items per sprint, in batched requests that stay under the response cap; a chunk over the cap leaves out
    // its sprints (P6-42).
    const readable = reads.filter((r) => r.query !== undefined);
    const perRequest = Math.max(1, Math.min(MAX_SPRINTS, Math.floor(ROWS_PER_REQUEST / pageSize)));
    for (let from = 0; from < readable.length; from += perRequest) {
      const chunk = readable.slice(from, from + perRequest);
      let data: unknown;
      try {
        data = (await agilityClient(ctx).query<unknown[]>(chunk.map((c) => (c.query as CompiledQuery).body)))
          .data;
      } catch (error) {
        if (error instanceof AbError && error.code === ErrorCode.LimitResponseTooLarge) {
          for (const c of chunk) c.skipped = 'its items did not fit in one response';
          continue;
        }
        throw error;
      }
      for (const [i, c] of chunk.entries()) {
        const set = Array.isArray(data) ? data[i] : undefined;
        const raw = Array.isArray(set)
          ? set.filter((r): r is Row => r !== null && typeof r === 'object' && !Array.isArray(r))
          : [];
        if (raw.length > pageSize) {
          c.skipped = `it had more than ${pageSize} items`;
          continue;
        }
        const { kept, hidden } = keep(ctx, c.query as CompiledQuery, raw);
        if (hidden > 0) partial = true;
        c.rows = kept;
      }
    }

    let uncategorised = 0;
    let skippedCount = 0;
    const sprints = reads.map((r) => {
      if (r.rows === undefined) {
        partial = true;
        skippedCount++;
        notes.push(`Sprint ${skippedCount} of the list is left out: ${r.skipped ?? 'it could not be read'}.`);
        return { oid: r.oid, name: r.name, read: false };
      }
      let completedItems = 0;
      let completed = 0;
      let known = 0;
      for (const row of r.rows) {
        const status = oidsOf(row['Status'])[0];
        const category = status === undefined ? undefined : statusCategory.get(status);
        if (category === undefined) uncategorised++;
        if (category !== 'completed') continue;
        completedItems++;
        const e = num(row['Estimate']);
        if (e !== undefined) {
          completed += e;
          known++;
        }
      }
      return {
        oid: r.oid,
        name: r.name,
        read: true,
        endDate: new Date(r.end).toISOString(),
        itemCount: r.rows.length,
        completedItems,
        // A sprint whose completed items have no estimate has no completed estimate, not zero (L-033).
        ...(completedItems === 0 || known > 0 ? { completedEstimate: round(completed) } : {}),
        ...(known < completedItems ? { unestimatedCompleted: completedItems - known } : {}),
      };
    });
    if (uncategorised > 0)
      notes.push(
        `${uncategorised} item${uncategorised === 1 ? ' has' : 's have'} no status category and ${uncategorised === 1 ? 'is' : 'are'} counted as not completed (history cannot read an item's state).`,
      );
    const estimates = sprints.flatMap((s) =>
      'completedEstimate' in s && typeof s.completedEstimate === 'number' ? [s.completedEstimate] : [],
    );
    const average =
      estimates.length === 0 ? undefined : round(estimates.reduce((a, b) => a + b, 0) / estimates.length);
    const readCount = sprints.filter((s) => s.read).length;
    if (reads.length === 0) notes.push('No past sprint was found for this team or project.');
    if (estimates.length < readCount)
      notes.push('Sprints without a completed estimate are not in the average.');
    notes.push(
      'Capacity is not reported: this Agility schema has no capacity model on sprints, and nothing is estimated in its place.',
    );

    const { output } = shapeOutput(ctx, {
      summary: [
        `Velocity of ${reads.length} past sprint${reads.length === 1 ? '' : 's'}: `,
        average === undefined
          ? 'no completed estimate could be read'
          : `${average} completed estimate on average over ${estimates.length} sprint${estimates.length === 1 ? '' : 's'}`,
        '.',
      ],
      notes,
      blocks: [
        {
          title: 'Sprints (newest first)',
          source: 'velocity sprints',
          rows: sprints,
          columns: ['oid', 'name', 'endDate', 'itemCount', 'completedItems', 'completedEstimate'],
        },
      ],
      partial,
      structured: {
        sprints,
        sprintsCounted: estimates.length,
        ...(average === undefined ? {} : { average }),
      },
      ...(input.format === undefined ? {} : { format: input.format }),
    });
    return output;
  },
});
