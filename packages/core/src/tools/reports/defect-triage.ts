// SPDX-License-Identifier: Apache-2.0
// defect_triage (P6-07): the open defects of a project, team or sprint read through search_work_items, flagged for
// triage: no owner, no sprint, unchanged for a long time, and likely duplicates by name similarity. Priority and
// severity are not read in this version (P6-30) and the report says so.
import { z } from 'zod';
import { capBudget, type ToolContext } from '../../context.ts';
import { AbError, ErrorCode } from '../../errors.ts';
import { runPage } from '../../identity/resolve.ts';
import { oidsOf } from '../../identity/scope.ts';
import { metadataFor } from '../../metadata/service.ts';
import { shapeOutput } from '../../output/result.ts';
import { compileQuery } from '../../query/compiler.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { projectArg, sprintArg, teamArg } from '../common.ts';
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
/** search_work_items (24) plus one guarded read of priority and severity (4: its query and the list metadata). */
const COST = 28;
const DAY = 86_400_000;
/** A defect not changed for this long is flagged stale. */
export const STALE_DEFECT_DAYS = 14;
const LIST_CAP = 20;
const PAIR_CAP = 10;
/** Name similarity (Jaccard over word sets) from which two defects are listed as likely duplicates. */
export const DUPLICATE_SIMILARITY = 0.6;
const TITLES = { open_defects: 'Open defects' };

/** Short function words that make unrelated titles look alike ("the", "not", "when"). English only: others pass through. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'not',
  'but',
  'are',
  'was',
  'has',
  'have',
  'when',
  'from',
  'that',
  'this',
  'then',
  'into',
  'does',
  'doesn',
  'cannot',
  'can',
]);

const words = (name: string): Set<string> =>
  new Set(
    name
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );

/** Jaccard similarity of two names' word sets; 0 when either has fewer than three words (too little to compare). */
export function nameSimilarity(a: string, b: string): number {
  return setSimilarity(words(a), words(b));
}

/** The same on word sets built once per name: a pair loop must not tokenise each name once per pair. */
function setSimilarity(x: ReadonlySet<string>, y: ReadonlySet<string>): number {
  if (x.size < 3 || y.size < 3) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

export interface TriageFields {
  /** Per defect OID: the priority name and its rank in the instance's list (lower is more urgent). */
  readonly priority: ReadonlyMap<string, { readonly name: string; readonly rank?: number }>;
  /** Per defect OID: the severity value, when exactly one severity-like attribute exists. */
  readonly severity: ReadonlyMap<string, string>;
  /** The type has no priority attribute on this instance. */
  readonly noPriorityList: boolean;
  /** `none`: no severity-like attribute; `ambiguous`: several, so none is read. */
  readonly severityAttribute: 'read' | 'none' | 'ambiguous';
  /** Why the read did not happen, when it did not (a budget or permission failure is said as such). */
  readonly unread?: 'budget' | 'forbidden' | 'failed';
}

const textOf = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * One guarded read of Priority and a severity-like attribute for the defects the search returned, through the
 * compiler (scope predicate and per-row recheck kept). The severity attribute is found in the metadata of the type:
 * a single-valued text or relation attribute whose name contains "severity"; its name is never put in a tool
 * definition or an output (P6-30, THREAT_MODEL A12). Several candidates read none (never a guess).
 */
export async function readTriageFields(ctx: ToolContext, oids: readonly string[]): Promise<TriageFields> {
  const empty = { priority: new Map(), severity: new Map() };
  const md = metadataFor(ctx);
  try {
    const meta = await md.assetType('Defect');
    const hasPriority = meta.attributes.get('Priority')?.kind === 'Relation';
    const candidates = [...meta.attributes.values()]
      .filter((a) => /severity/i.test(a.name) && !a.multi && (a.kind === 'Text' || a.kind === 'Relation'))
      .sort((a, b) => a.name.localeCompare(b.name));
    const severityAttribute = candidates.length === 0 ? 'none' : candidates.length > 1 ? 'ambiguous' : 'read';
    const sev = severityAttribute === 'read' ? candidates[0] : undefined;
    if ((!hasPriority && sev === undefined) || oids.length === 0)
      return { ...empty, noPriorityList: !hasPriority, severityAttribute };
    const wanted = [
      ...(hasPriority ? ['Priority.Name', 'Priority.Order'] : []),
      ...(sev === undefined ? [] : [sev.kind === 'Relation' ? `${sev.name}.Name` : sev.name]),
    ];
    const fields: string[] = [];
    for (const f of wanted) {
      try {
        fields.push((await md.resolvePath('Defect', f)).path);
      } catch (error) {
        if (!(error instanceof AbError) || error.code !== ErrorCode.InputInvalid) throw error;
      }
    }
    const compiled = await compileQuery(ctx, {
      assetType: 'Defect',
      fields,
      // The OIDs come from this call's own scope-checked search (up to 100 rows), not from the caller: a trusted list,
      // which the compiler bounds at 2,000 instead of 50 (P6-57, found on the live tenant).
      filters: [{ field: 'ID', op: 'in', value: [...oids], trusted: true }],
      includeClosed: true,
      limit: Math.min(oids.length, ctx.limits.maxRows),
    });
    const priority = new Map<string, { name: string; rank?: number }>();
    const severity = new Map<string, string>();
    for (const row of (await runPage(ctx, compiled)).rows) {
      const oid = oidsOf(row['_oid'])[0];
      if (oid === undefined) continue;
      const name = textOf(row['Priority.Name']);
      const order = row['Priority.Order'];
      if (name !== undefined)
        priority.set(oid, {
          name,
          ...(typeof order === 'number' && Number.isFinite(order) ? { rank: order } : {}),
        });
      const sv =
        sev === undefined ? undefined : textOf(row[sev.kind === 'Relation' ? `${sev.name}.Name` : sev.name]);
      if (sv !== undefined) severity.set(oid, sv);
    }
    return { priority, severity, noPriorityList: !hasPriority, severityAttribute };
  } catch (error) {
    if (!(error instanceof AbError)) throw error;
    const unread =
      error.code === ErrorCode.BudgetExhausted
        ? 'budget'
        : error.code === ErrorCode.AuthForbidden
          ? 'forbidden'
          : 'failed';
    return { ...empty, noPriorityList: false, severityAttribute: 'none', unread };
  }
}

export const defectTriage: ToolDefinition = defineTool({
  name: NAME,
  title: 'Defect triage',
  description:
    'Triage the open defects of an Agility project, team or sprint: those with no owner, no sprint or no change for 14 days, and likely duplicates by name similarity. Priority (in the instance’s own rank order) and severity, where the instance has them, are shown and order the flagged list. Reads the first page only (at most 100 defects) and says when more exist. Not paged. Cold call: up to 28 Agility requests.',
  kind: 'read',
  group: 'reports',
  // search_work_items, capped at its own cost.
  cost: COST,
  inputSchema: z.object({
    project: projectArg,
    team: teamArg,
    sprint: sprintArg,
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
      // Oldest change first: the stale defects and the old twins of newer ones are what triage looks for, and
      // they are the ones a newest-first page would cut.
      sort_by: 'oldest_changed',
      limit: Math.min(100, ctx.limits.maxRows),
    });
    const runs = [run];
    rethrowIfNothingRead(runs);
    const notes = sectionNotes(runs, TITLES);
    let counts: Record<string, unknown> | undefined;
    let flagged: Record<string, unknown>[] = [];
    let pairs: Record<string, unknown>[] = [];
    let more = false;
    let pairsCut = 0;
    let flaggedTotal = 0;
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
      const fieldsRead = await readTriageFields(
        ctx,
        rows.flatMap((r) => (typeof r['oid'] === 'string' ? [r['oid']] : [])),
      );
      const prioOf = (r: Record<string, unknown>) => fieldsRead.priority.get(String(r['oid']));
      const noDate = rows.filter((r) => !Number.isFinite(changedMs(r))).length;
      if (noDate > 0) notes.push(`${noDate} defects have no change date and are not checked for staleness.`);
      if (more)
        notes.push(
          'More open defects exist than the first page, read oldest change first: counts and duplicates cover the page only and lean towards stale defects.',
        );
      if (run.data?.['hiddenOutsideScope'] === true)
        notes.push('Some defects were left out because they are outside the workspace.');
      const withPriority = fieldsRead.priority.size;
      notes.push(
        'Age is the days since the last change, not since creation. Likely duplicates are a name-similarity hint, not a judgement.',
      );
      if (fieldsRead.unread === 'budget')
        notes.push(
          'Priority and severity were not read: the request budget of this call ran out. Repeat the call.',
        );
      else if (fieldsRead.unread === 'forbidden')
        notes.push('Priority and severity were not read: this token or workspace may not read them.');
      else if (fieldsRead.unread === 'failed')
        notes.push('Priority and severity could not be read; the list is not ordered by priority.');
      else {
        notes.push(
          fieldsRead.noPriorityList
            ? 'This instance has no priority on defects, so the list is not ordered by priority.'
            : `Priority is shown for ${withPriority} of ${rows.length} defects read and orders the flagged list, most urgent first (rank order of the instance's list); defects without one come last.`,
        );
        if (fieldsRead.severityAttribute === 'ambiguous')
          notes.push('Several severity-like attributes exist on defects, so severity is not read.');
        else if (fieldsRead.severityAttribute === 'none')
          notes.push('This instance has no severity on defects.');
      }
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
      flaggedTotal = view.filter((v) => v.flags.length > 0).length;
      flagged = view
        .filter((v) => v.flags.length > 0)
        .sort(
          (a, b) =>
            (prioOf(a.row)?.rank ?? Number.POSITIVE_INFINITY) -
              (prioOf(b.row)?.rank ?? Number.POSITIVE_INFINITY) ||
            b.flags.length - a.flags.length ||
            (b.daysSinceChange ?? -1) - (a.daysSinceChange ?? -1),
        )
        .slice(0, LIST_CAP)
        .map((v) => ({
          ...(strOf(v.row['number']) === undefined ? {} : { number: v.row['number'] }),
          oid: v.row['oid'],
          flags: v.flags,
          ...(v.daysSinceChange === undefined ? {} : { daysSinceChange: v.daysSinceChange }),
          ...(prioOf(v.row) === undefined ? {} : { priority: prioOf(v.row)?.name }),
          ...(fieldsRead.severity.get(String(v.row['oid'])) === undefined
            ? {}
            : { severity: fieldsRead.severity.get(String(v.row['oid'])) }),
          ...(strOf(v.row['status']) === undefined ? {} : { status: v.row['status'] }),
          ...(strOf(v.row['name']) === undefined ? {} : { name: v.row['name'] }),
        }));
      // Every pair is scored (at most 100 defects), then the most similar come first (ties keep the page order).
      const found: Array<{ similarity: number; at: number; pair: Record<string, unknown> }> = [];
      const wordSets = rows.map((r) => words(strOf(r['name']) ?? ''));
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          const a = rows[i] as Record<string, unknown>;
          const b = rows[j] as Record<string, unknown>;
          const sim = setSimilarity(wordSets[i] as Set<string>, wordSets[j] as Set<string>);
          if (sim >= DUPLICATE_SIMILARITY)
            found.push({
              similarity: sim,
              at: found.length,
              pair: {
                first: strOf(a['number']) ?? a['oid'],
                second: strOf(b['number']) ?? b['oid'],
                similarity: Math.round(sim * 100) / 100,
              },
            });
        }
      }
      found.sort((x, y) => y.similarity - x.similarity || x.at - y.at);
      if (found.length > PAIR_CAP) {
        pairsCut = found.length - PAIR_CAP;
        notes.push(
          `${found.length} likely duplicate pairs found: the ${PAIR_CAP} most similar are listed, ${pairsCut} are not.`,
        );
      }
      if (flaggedTotal > LIST_CAP)
        notes.push(
          `${flaggedTotal} defects are flagged: the first ${LIST_CAP} are listed (most flags, then oldest).`,
        );
      pairs = found.slice(0, PAIR_CAP).map((f) => f.pair);
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
      partial: incomplete(runs) || more || run.data?.['hiddenOutsideScope'] === true,
      structured: {
        sections: sectionInfos(runs),
        ...(counts === undefined
          ? {}
          : {
              counts: {
                ...counts,
                flagged: flaggedTotal,
                ...(pairsCut > 0 ? { duplicatePairsNotListed: pairsCut } : {}),
              },
              flagged,
              likelyDuplicates: pairs,
            }),
      },
      meta: { queries: allQueries(runs) },
    });
    return output;
  },
});
