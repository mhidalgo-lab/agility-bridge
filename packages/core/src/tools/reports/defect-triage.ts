// SPDX-License-Identifier: Apache-2.0
// defect_triage (P6-07): the open defects of a project, team or sprint read through search_work_items, flagged for
// triage: no owner, no sprint, unchanged for a long time, and likely duplicates by name similarity. Priority and
// severity are not read in this version (P6-30) and the report says so.
import { z } from 'zod';
import { capBudget } from '../../context.ts';
import { shapeOutput } from '../../output/result.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { searchWorkItems } from '../work/search.ts';
import {
  allQueries,
  arr,
  incomplete,
  reportOutput,
  rethrowIfNothingRead,
  runSection,
  sectionInfos,
  sectionNotes,
  strOf,
} from './common.ts';

const NAME = 'defect_triage';
/** search_work_items (24). */
const COST = 24;
const DAY = 86_400_000;
/** A defect not changed for this long is flagged stale. */
export const STALE_DEFECT_DAYS = 14;
const LIST_CAP = 20;
const PAIR_CAP = 10;
/** Name similarity (Jaccard over word sets) from which two defects are listed as likely duplicates. */
export const DUPLICATE_SIMILARITY = 0.6;
const TITLES = { open_defects: 'Open defects' };

const words = (name: string): Set<string> =>
  new Set(
    name
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2),
  );

/** Jaccard similarity of two names' word sets; 0 when either has fewer than three words (too little to compare). */
export function nameSimilarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size < 3 || y.size < 3) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

export const defectTriage: ToolDefinition = defineTool({
  name: NAME,
  title: 'Defect triage',
  description:
    'Triage the open defects of an Agility project, team or sprint: those with no owner, no sprint or no change for 14 days, and likely duplicates by name similarity. Priority and severity are not read. Reads the first page only (at most 100 defects) and says when more exist. Not paged. A cold call can make up to 24 Agility requests.',
  kind: 'read',
  group: 'reports',
  // search_work_items, capped at its own cost.
  cost: COST,
  inputSchema: z.object({
    project: z.string().min(1).max(200).optional().describe('Agility project name or Scope:<id>.'),
    team: z.string().min(1).max(200).optional().describe('Team name or Team:<id>.'),
    sprint: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Sprint name, Timebox:<id>, or current, previous or next.'),
  }),
  outputSchema: reportOutput({
    counts: z.looseObject({}).optional(),
  }),
  handler: async (input, outer) => {
    const ctx = { ...outer, budget: capBudget(outer.budget, COST) };
    const now = ctx.clock.now();
    const run = await runSection(ctx, 'open_defects', searchWorkItems, {
      asset_type: 'Defect',
      ...(input.project === undefined ? {} : { project: input.project }),
      ...(input.team === undefined ? {} : { team: input.team }),
      ...(input.sprint === undefined ? {} : { sprint: input.sprint }),
      include_closed: false,
      sort_by: 'recently_changed',
      limit: Math.min(100, ctx.limits.maxRows),
    });
    const runs = [run];
    rethrowIfNothingRead(runs);
    const notes = sectionNotes(runs, TITLES);
    let counts: Record<string, unknown> | undefined;
    let flagged: Record<string, unknown>[] = [];
    let pairs: Record<string, unknown>[] = [];
    let more = false;
    if (run.info.status === 'ok') {
      const rows = arr(run.data?.['items']);
      more = typeof run.data?.['nextCursor'] === 'string';
      const changedMs = (r: Record<string, unknown>) => Date.parse(strOf(r['changedAt']) ?? '');
      const view = rows.map((r) => {
        const t = changedMs(r);
        const flags: string[] = [];
        if (!(Array.isArray(r['owners']) && r['owners'].length > 0)) flags.push('no_owner');
        if (r['sprint'] === undefined) flags.push('no_sprint');
        if (Number.isFinite(t) && now - t > STALE_DEFECT_DAYS * DAY) flags.push('stale');
        return {
          row: r,
          flags,
          ...(Number.isFinite(t) ? { daysSinceChange: Math.max(0, Math.floor((now - t) / DAY)) } : {}),
        };
      });
      const noDate = rows.filter((r) => !Number.isFinite(changedMs(r))).length;
      if (noDate > 0) notes.push(`${noDate} defects have no change date and are not checked for staleness.`);
      if (more)
        notes.push('More open defects exist than the first page: counts and duplicates cover the page only.');
      if (run.data?.['hiddenOutsideScope'] === true)
        notes.push('Some defects were left out because they are outside the workspace.');
      notes.push(
        'Priority and severity are not read. Age is the days since the last change, not since creation. Likely duplicates are a name-similarity hint, not a judgement.',
      );
      if (rows.length > 0 && rows.every((r) => r['sprint'] === undefined))
        notes.push(
          'No defect read carries a sprint: either none is planned or this instance does not expose it; the no-sprint count may not be reliable.',
        );
      const count = (flag: string) => view.filter((v) => v.flags.includes(flag)).length;
      counts = {
        openRead: rows.length,
        noOwner: count('no_owner'),
        noSprint: count('no_sprint'),
        ...(noDate === rows.length && rows.length > 0 ? {} : { stale: count('stale') }),
        lowerBound: more,
      };
      flagged = view
        .filter((v) => v.flags.length > 0)
        .sort(
          (a, b) => b.flags.length - a.flags.length || (b.daysSinceChange ?? -1) - (a.daysSinceChange ?? -1),
        )
        .slice(0, LIST_CAP)
        .map((v) => ({
          ...(strOf(v.row['number']) === undefined ? {} : { number: v.row['number'] }),
          oid: v.row['oid'],
          flags: v.flags,
          ...(v.daysSinceChange === undefined ? {} : { daysSinceChange: v.daysSinceChange }),
          ...(strOf(v.row['status']) === undefined ? {} : { status: v.row['status'] }),
          ...(strOf(v.row['name']) === undefined ? {} : { name: v.row['name'] }),
        }));
      const found: Record<string, unknown>[] = [];
      for (let i = 0; i < rows.length && found.length < PAIR_CAP; i++) {
        for (let j = i + 1; j < rows.length && found.length < PAIR_CAP; j++) {
          const a = rows[i] as Record<string, unknown>;
          const b = rows[j] as Record<string, unknown>;
          const s = nameSimilarity(strOf(a['name']) ?? '', strOf(b['name']) ?? '');
          if (s >= DUPLICATE_SIMILARITY)
            found.push({
              first: strOf(a['number']) ?? a['oid'],
              second: strOf(b['number']) ?? b['oid'],
              similarity: Math.round(s * 100) / 100,
            });
        }
      }
      pairs = found;
    }
    const { output } = shapeOutput(ctx, {
      summary:
        counts === undefined
          ? 'Defect triage: the defects were not read.'
          : `Defect triage: ${counts['openRead']} open defect${counts['openRead'] === 1 ? '' : 's'} read${more ? ' (more exist)' : ''}; ${counts['noOwner']} without an owner, ${counts['noSprint']} without a sprint${counts['stale'] === undefined ? '' : `, ${counts['stale']} unchanged for ${STALE_DEFECT_DAYS} days`}.`,
      notes,
      blocks: [
        ...(counts === undefined
          ? []
          : [{ title: 'Defects to triage', source: 'flagged defects', rows: flagged }]),
        ...(pairs.length === 0 ? [] : [{ title: 'Likely duplicates', source: 'defect pairs', rows: pairs }]),
      ],
      partial: incomplete(runs) || more,
      structured: {
        sections: sectionInfos(runs),
        ...(counts === undefined ? {} : { counts, flagged, likelyDuplicates: pairs }),
      },
      meta: { queries: allQueries(runs) },
    });
    return output;
  },
});
