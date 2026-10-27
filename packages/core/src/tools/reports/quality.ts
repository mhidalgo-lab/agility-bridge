// SPDX-License-Identifier: Apache-2.0
// work_item_quality (P6-07, D-92): scores one backlog item or defect with the versioned rubric of
// `packages/core/src/rubric.ts` (the same one the resource and the review prompt serve). The checks are mechanical
// (word counts, key phrases, fields present) and say so; a criterion that cannot be assessed from what was read is
// `null`, the score becomes a range and a level is named only when the whole range lies in one (L-033).
import { z } from 'zod';
import { capBudget, type ToolContext } from '../../context.ts';
import { AbError } from '../../errors.ts';
import { resolveAsset, runPage } from '../../identity/resolve.ts';
import { oidsOf } from '../../identity/scope.ts';
import { metadataFor } from '../../metadata/service.ts';
import { shapeOutput, untrusted } from '../../output/result.ts';
import { compileQuery } from '../../query/compiler.ts';
import { invalid } from '../../query/limits.ts';
import { BACKLOG_ITEM_QUALITY_RUBRIC, type RubricCriterion } from '../../rubric.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { workItemArg } from '../common.ts';
import { getWorkItem } from '../work/get-item.ts';
import {
  allQueries,
  incomplete,
  numOf,
  obj,
  reportOutput,
  rethrowIfNothingRead,
  runSection,
  type SectionRun,
  sectionInfos,
  sectionNotes,
  strOf,
} from './common.ts';

const NAME = 'work_item_quality';
/** get_work_item (24) plus one priority read (the compiler may need metadata of the priority type). */
const COST = 28;
const TITLES = { item: 'Work item' };
/** An estimate above this is "large" for the size criterion. */
export const LARGE_ESTIMATE = 8;

export interface Facts {
  readonly name: string;
  readonly description: string;
  readonly acceptance: string | undefined;
  readonly hasAcceptanceField: boolean;
  readonly estimate: number | undefined;
  readonly hasEstimateField: boolean;
  readonly hasEpic: boolean;
  readonly hasProject: boolean;
  readonly hasOwnerOrTeam: boolean;
  /** Whether a priority is set; undefined when it could not be read. */
  readonly hasPriority: boolean | undefined;
}

export interface CriterionResult {
  readonly id: string;
  readonly title: string;
  readonly weight: number;
  /** 0 to 2, or null when it cannot be assessed from what was read. */
  readonly score: 0 | 1 | 2 | null;
  readonly evidence: string;
}

const ROLE = /\bas (?:an?|the)\b/i;
const WHY = /\bso that\b|\bin order to\b|\bbecause\b/i;
/**
 * Given ... when ... then, in that order. Three anchored searches, each linear: a single `given[\s\S]*when[\s\S]*then`
 * regexp backtracks cubically on hostile text (Agility text is untrusted, and a description is editable by anyone).
 */
export function hasGivenWhenThen(text: string): boolean {
  const g = /\bgiven\b/i.exec(text);
  if (g === null) return false;
  const afterGiven = text.slice(g.index + g[0].length);
  const w = /\bwhen\b/i.exec(afterGiven);
  if (w === null) return false;
  return /\bthen\b/i.test(afterGiven.slice(w.index + w[0].length));
}
const MODAL = /\b(?:should|must|shall|can|cannot|displays?|shows?|is shown|returns?|redirects?)\b/i;
const OPEN = /\b(?:tbd|tbc|todo|fixme|to be (?:decided|defined|determined|confirmed))\b|\?\?+/gi;

const wordCount = (s: string): number => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

function acceptanceLines(text: string): string[] {
  return text
    .split(/\r?\n|•|(?:^|\s)[-*]\s|(?:^|\s)\d+[.)]\s/)
    .map((l) => l.trim())
    .filter((l) => l.length > 8);
}

type Score = 0 | 1 | 2 | null;
const result = (c: RubricCriterion, score: Score, evidence: string): CriterionResult => ({
  id: c.id,
  title: c.title,
  weight: c.weight,
  score,
  evidence,
});

/** One rubric criterion judged from the facts; never a guess for what was not read. */
export function assess(c: RubricCriterion, f: Facts): CriterionResult {
  switch (c.id) {
    case 'clear_title': {
      const n = wordCount(f.name);
      return result(c, n < 3 ? 0 : n < 4 ? 1 : 2, `${n} words in the title`);
    }
    case 'user_value': {
      const role = ROLE.test(f.description) || ROLE.test(f.name);
      const why = WHY.test(f.description);
      if (role && why) return result(c, 2, 'states who and why');
      if (role || why || f.hasEpic)
        return result(c, 1, `${role ? 'who' : why ? 'why' : 'only the parent epic'} is stated`);
      return result(c, 0, 'no who, why or parent epic found');
    }
    case 'acceptance_criteria': {
      // Without an acceptance field, only the text after the words "acceptance criteria" in the description counts:
      // prose that merely mentions the phrase must not score as the criteria themselves.
      const phrase = /acceptance criteria/i.exec(f.description);
      const text =
        f.acceptance ?? (phrase === null ? '' : f.description.slice(phrase.index + phrase[0].length));
      if (text.trim() === '')
        return result(
          c,
          0,
          f.hasAcceptanceField ? 'the acceptance field is empty' : 'none found in the description',
        );
      const lines = acceptanceLines(text);
      const testable = hasGivenWhenThen(text) || MODAL.test(text);
      return lines.length >= 3 && testable
        ? result(c, 2, `${lines.length} criteria with testable wording`)
        : result(c, 1, `${lines.length} criteria${testable ? '' : ', no testable wording'}`);
    }
    case 'size': {
      if (f.estimate === undefined)
        return f.hasEstimateField
          ? result(c, 0, 'no estimate')
          : result(c, null, 'this type has no estimate on this instance');
      return f.estimate > LARGE_ESTIMATE
        ? result(c, 1, `estimate ${f.estimate} is above ${LARGE_ESTIMATE}`)
        : result(c, 2, `estimate ${f.estimate}`);
    }
    case 'clarity': {
      if (f.description.trim() === '') return result(c, null, 'no description to check');
      const markers = (f.description.match(OPEN) ?? []).length;
      const questions = (f.description.match(/\?/g) ?? []).length;
      const hits = markers + (questions > 0 ? 1 : 0);
      return hits === 0
        ? result(c, 2, 'no TBD markers or questions found')
        : result(c, hits >= 3 ? 0 : 1, `${markers} TBD-style markers, ${questions} question marks`);
    }
    case 'ready_to_start': {
      const parts = [f.hasProject, f.hasOwnerOrTeam, f.hasPriority];
      const missing = parts.filter((p) => p === false).length;
      if (f.hasPriority === undefined)
        return missing >= 2
          ? result(c, 0, 'project and owner or team are missing; priority not read')
          : result(c, null, 'priority could not be read, so all parts cannot be confirmed');
      return result(
        c,
        missing === 0 ? 2 : missing === 1 ? 1 : 0,
        `${missing} of project, owner or team, priority missing`,
      );
    }
    default:
      return result(c, null, 'not assessed by this version');
  }
}

/** The score range and level of the assessed criteria: a level only when min and max agree. */
export function summarise(results: readonly CriterionResult[]): {
  score?: number;
  scoreMin: number;
  scoreMax: number;
  level?: string;
  unassessed: string[];
} {
  let min = 0;
  let unknownWeight = 0;
  const unassessed: string[] = [];
  for (const r of results) {
    if (r.score === null) {
      unknownWeight += r.weight;
      unassessed.push(r.id);
    } else min += (r.weight * r.score) / 2;
  }
  const max = min + unknownWeight;
  const levelOf = (s: number) => BACKLOG_ITEM_QUALITY_RUBRIC.levels.find((l) => s >= l.min)?.label;
  const lo = levelOf(min);
  const hi = levelOf(max);
  return {
    ...(unknownWeight === 0 ? { score: min } : {}),
    scoreMin: min,
    scoreMax: max,
    ...(lo !== undefined && lo === hi ? { level: lo } : {}),
    unassessed,
  };
}

/** Whether the item has a priority: one guarded read; undefined when it cannot be read (never assumed). */
async function readPriority(ctx: ToolContext, type: string, oid: string): Promise<boolean | undefined> {
  try {
    const meta = await metadataFor(ctx).assetType(type);
    if (!meta.attributes.has('Priority')) return undefined;
    const compiled = await compileQuery(ctx, {
      assetType: type,
      fields: ['Priority'],
      filters: [{ field: 'ID', op: 'eq', value: oid }],
      includeClosed: true,
      limit: 1,
    });
    const row = (await runPage(ctx, compiled)).rows[0];
    return row === undefined ? undefined : oidsOf(row['Priority'])[0] !== undefined;
  } catch (error) {
    if (error instanceof AbError) return undefined;
    throw error;
  }
}

export const workItemQuality: ToolDefinition = defineTool({
  name: NAME,
  title: 'Work item quality',
  description:
    'Score one backlog item or defect against the versioned quality rubric (resource backlog-item-quality): title, stated value, acceptance criteria, size, open questions, readiness. Checks are mechanical; a criterion that cannot be assessed is null and the score becomes a range. Dependencies are not read. Not paged. Cold call: up to 28 Agility requests.',
  kind: 'read',
  group: 'reports',
  // get_work_item (24) and one guarded priority read, capped here.
  cost: COST,
  inputSchema: z.object({
    asset: workItemArg,
  }),
  outputSchema: reportOutput({
    rubric: z.looseObject({ id: z.string(), version: z.string() }),
    criteria: z.array(z.looseObject({ id: z.string() })),
  }),
  handler: async (input, outer) => {
    const ctx = { ...outer, budget: capBudget(outer.budget, COST) };
    const run = await runSection(ctx, 'item', getWorkItem, { asset: input.asset, minimal_output: true });
    const runs: SectionRun[] = [run];
    rethrowIfNothingRead(runs);
    const notes = sectionNotes(runs, TITLES);
    const rubric = BACKLOG_ITEM_QUALITY_RUBRIC;
    const item = obj(run.data?.['item']);
    const type = strOf(item?.['assetType']);
    if (run.info.status === 'ok' && (type === undefined || !rubric.appliesTo.includes(type)))
      throw invalid(
        `The quality rubric scores ${rubric.appliesTo.join(' and ')} items; ${type ?? 'this asset'} is not one.`,
        'Pass a backlog item or defect.',
      );
    let results: CriterionResult[] = [];
    let summary: ReturnType<typeof summarise> | undefined;
    if (item !== undefined && type !== undefined) {
      const meta = await metadataFor(ctx).assetType(type);
      const hasAcceptanceField = [...meta.attributes.values()].some(
        (a) => /accept(?:ance)?_?crit/i.test(a.name) && a.kind === 'LongText',
      );
      const hasPriority = await readPriority(ctx, type, String(item['oid']));
      const facts: Facts = {
        name: strOf(item['name']) ?? '',
        description: strOf(item['description']) ?? '',
        acceptance: strOf(item['acceptanceCriteria']),
        hasAcceptanceField,
        estimate: numOf(item['estimate']),
        hasEstimateField: meta.attributes.has('Estimate'),
        hasEpic: obj(item['epic']) !== undefined,
        hasProject: obj(item['project']) !== undefined,
        hasOwnerOrTeam:
          (Array.isArray(item['owners']) && item['owners'].length > 0) || strOf(item['team']) !== undefined,
        hasPriority,
      };
      results = rubric.criteria.map((c) => assess(c, facts));
      summary = summarise(results);
      if (hasPriority === undefined)
        notes.push('Priority could not be read on this item, so the readiness criterion may be unassessed.');
      if (summary.unassessed.length > 0)
        notes.push(
          `Not assessed: ${summary.unassessed.join(', ')}. The score is a range${summary.level === undefined ? ' and no level is named' : ''}.`,
        );
    }
    notes.push(
      'Mechanical checks (word counts, key phrases, fields present), not a judgement; dependencies are not read. Use the result to start a conversation.',
    );
    const improve = (r: CriterionResult) => rubric.criteria.find((c) => c.id === r.id)?.question ?? r.title;
    const rows = results.map((r) => ({
      criterion: r.id,
      weight: r.weight,
      score: r.score,
      evidence: r.evidence,
    }));
    const suggestions = results
      .filter((r) => r.score !== 2)
      .map((r) => ({ criterion: r.id, check: improve(r) }));
    const scoreText =
      summary === undefined
        ? 'not scored'
        : summary.score !== undefined
          ? `${summary.score}/100${summary.level === undefined ? '' : ` (${summary.level})`}`
          : `between ${summary.scoreMin} and ${summary.scoreMax} of 100${summary.level === undefined ? '' : ` (${summary.level})`}`;
    const { output } = shapeOutput(ctx, {
      summary: [
        `Quality of ${strOf(item?.['number']) ?? 'the item'} `,
        untrusted(item?.['name']),
        `: ${scoreText}, rubric ${rubric.id} ${rubric.version}.`,
      ],
      notes,
      blocks: [
        { title: 'Criteria', source: 'quality criteria', rows },
        ...(suggestions.length === 0
          ? []
          : [{ title: 'To check', source: 'quality checks', rows: suggestions }]),
      ],
      partial: incomplete(runs) || (summary?.unassessed.length ?? 0) > 0,
      structured: {
        sections: sectionInfos(runs),
        rubric: { id: rubric.id, version: rubric.version },
        ...(item === undefined
          ? {}
          : {
              item: {
                ...(strOf(item['number']) === undefined ? {} : { number: item['number'] }),
                assetType: item['assetType'],
                oid: item['oid'],
              },
            }),
        // A null score is not shown by the shaper: `assessed: false` and no `score` mean not assessed.
        criteria: results.map((r) => ({ ...r, assessed: r.score !== null })),
        ...(summary === undefined
          ? {}
          : {
              ...(summary.score === undefined ? {} : { score: summary.score }),
              scoreMin: summary.scoreMin,
              scoreMax: summary.scoreMax,
              ...(summary.level === undefined ? {} : { level: summary.level }),
            }),
        suggestions,
      },
      meta: { queries: allQueries(runs) },
    });
    return output;
  },
});
