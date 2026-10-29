// SPDX-License-Identifier: Apache-2.0
// quality_scan (P6-29): the quality rubric over the open stories and defects of a sprint or an epic, from one batched
// read of their text fields. It uses the same versioned rubric and the same `assess` and `summarise` as
// `work_item_quality` (D-103), so a scan and a one-by-one call agree on the same data; a criterion that cannot be
// assessed is `null`, the score is a range and no level is named unless the whole range lies in one (L-033).
import { z } from 'zod';
import { agilityClient } from '../../agility/client.ts';
import { capBudget, withMemo } from '../../context.ts';
import { resolveAsset, resolveSprint } from '../../identity/resolve.ts';
import { inScope, oidsOf, sanitizeRow } from '../../identity/scope.ts';
import { metadataFor } from '../../metadata/service.ts';
import { safeText } from '../../output/format.ts';
import { shapeOutput, untrusted } from '../../output/result.ts';
import { richText } from '../../output/text.ts';
import { type CompiledQuery, compileQuery } from '../../query/compiler.ts';
import { invalid } from '../../query/limits.ts';
import { BACKLOG_ITEM_QUALITY_RUBRIC } from '../../rubric.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { isAcceptanceAttribute, sprintArg } from '../common.ts';
import { identityFor } from '../work/items.ts';
import { readableWorkTypes } from '../work/search.ts';
import { granted, type SectionInfo } from './common.ts';
import { assess, type CriterionResult, type Facts, summarise } from './quality.ts';

const NAME = 'quality_scan';
/** The sprint or epic lookup (up to 4), metadata of two types (up to 4) and one batched read of both types. */
const COST = 30;
/** Most items scored in one call. */
export const SCAN_CAP = 50;
const TITLES = { items: 'Items' };
/** The cap of one text value, as the item tool shows it (so a scan and a one-by-one call read the same text). */
const TEXT_CHARS = 4_000;

type Row = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const shown = (v: unknown): string | undefined => {
  const t = str(v);
  return t === undefined ? undefined : str(safeText(richText(t), TEXT_CHARS).text);
};

export const qualityScan: ToolDefinition = defineTool({
  name: NAME,
  title: 'Quality scan',
  description: `Rank all the open stories and defects of a sprint or an epic by how ready they are for refinement, weakest first, using the versioned rubric (resource backlog-item-quality) over one read of their text. Give a sprint or an epic. For one item use work_item_quality. An item below a sub-epic is not included. At most ${SCAN_CAP} items per type; more are reported as partial. Not paged. Cold call: up to ${COST} Agility requests.`,
  kind: 'read',
  group: 'reports',
  cost: COST,
  inputSchema: z.object({
    sprint: sprintArg,
    epic: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Epic number or OID token (its direct backlog items).'),
  }),
  outputSchema: z.looseObject({
    sections: z.array(z.looseObject({ key: z.string(), tool: z.string(), status: z.string() })),
    rubric: z.looseObject({ id: z.string(), version: z.string() }).optional(),
    items: z.array(z.looseObject({ oid: z.string() })).optional(),
    truncated: z.boolean().optional(),
    partial: z.boolean().optional(),
    notes: z.array(z.string()).optional(),
  }),
  handler: async (input, outer) => {
    if ((input.sprint === undefined) === (input.epic === undefined))
      throw invalid(
        'Give exactly one of sprint or epic.',
        'Pass a sprint or an epic, not both and not neither.',
      );
    const ctx = withMemo({ ...outer, budget: capBudget(outer.budget, COST) });
    const rubric = BACKLOG_ITEM_QUALITY_RUBRIC;
    const info = (status: SectionInfo['status'], requests = 0): SectionInfo => ({
      key: 'items',
      tool: 'get_work_item',
      status,
      requests,
    });
    // Reading the text of items is what get_work_item grants: without it nothing is read (L-037).
    if (!granted(ctx, 'get_work_item')) {
      const { output } = shapeOutput(ctx, {
        summary: 'Quality scan: not read.',
        notes: [
          `Section "${TITLES.items}" skipped: get_work_item is not granted to this caller, so it was not read.`,
        ],
        partial: true,
        structured: { sections: [info('skipped')] },
      });
      return output;
    }
    const types = readableWorkTypes(ctx, ['Story', 'Defect']);
    if (types.length === 0)
      throw invalid('No backlog item or defect type is allowed in this workspace.', 'Ask for a wider grant.');
    const md = metadataFor(ctx);
    const used0 = ctx.budget.used;

    let filter: { field: string; value: string };
    let target: { kind: 'sprint' | 'epic'; oid: string; name?: string };
    if (input.sprint !== undefined) {
      const sprint = await resolveSprint(ctx, input.sprint);
      filter = { field: 'Timebox', value: sprint.oid };
      target = { kind: 'sprint', oid: sprint.oid, name: sprint.name };
    } else {
      const epic = await resolveAsset(ctx, input.epic as string);
      if (epic.assetType !== 'Epic')
        throw invalid(
          `${epic.assetType} is not a portfolio item (epic).`,
          'Pass an epic number or OID token, or a sprint.',
        );
      filter = { field: 'Super', value: epic.oid };
      target = { kind: 'epic', oid: epic.oid, ...(epic.name === undefined ? {} : { name: epic.name }) };
    }

    const queries: Array<{ type: string; compiled: CompiledQuery; accept?: string; hasEstimate: boolean }> =
      [];
    for (const type of types) {
      const meta = await md.assetType(type);
      const has = (a: string) => meta.attributes.has(a.split('.')[0] as string);
      const accept = [...meta.attributes.values()].find(
        (a) => isAcceptanceAttribute(a.name) && a.kind === 'LongText',
      )?.name;
      if (!has(filter.field)) continue;
      const fields = [
        'Name',
        'Description',
        'Estimate',
        'Super',
        'Scope',
        'Owners.Name',
        'Team.Name',
        'Priority',
        ...(accept === undefined ? [] : [accept]),
      ].filter(has);
      queries.push({
        type,
        hasEstimate: meta.attributes.has('Estimate'),
        ...(accept === undefined ? {} : { accept }),
        compiled: await compileQuery(
          ctx,
          {
            assetType: type,
            fields,
            filters: [{ field: filter.field, op: 'eq', value: filter.value, trusted: true }],
            limit: SCAN_CAP + 1,
          },
          { identityFields: await identityFor(type, ctx) },
        ),
      });
    }
    const res = await agilityClient(ctx).query<unknown[]>(queries.map((q) => q.compiled.body));

    const scored: Array<{
      type: string;
      row: Row;
      results: CriterionResult[];
      summary: ReturnType<typeof summarise>;
    }> = [];
    let hidden = 0;
    let more = false;
    for (const [i, q] of queries.entries()) {
      const set = Array.isArray(res.data) ? res.data[i] : undefined;
      const rows = (Array.isArray(set) ? set : []).filter(
        (r): r is Row => r !== null && typeof r === 'object' && !Array.isArray(r),
      );
      const kept = rows.filter((r) => inScope(ctx, q.compiled, r));
      hidden += rows.length - kept.length;
      if (kept.length > SCAN_CAP) more = true;
      for (const r of kept.slice(0, SCAN_CAP)) {
        sanitizeRow(ctx, q.compiled, r);
        const priorityKnown = (await md.assetType(q.type)).attributes.has('Priority');
        const facts: Facts = {
          name: shown(r['Name']) ?? '',
          description: shown(r['Description']) ?? '',
          acceptance: q.accept === undefined ? undefined : shown(r[q.accept]),
          hasAcceptanceField: q.accept !== undefined,
          estimate:
            typeof r['Estimate'] === 'number' && Number.isFinite(r['Estimate']) ? r['Estimate'] : undefined,
          hasEstimateField: q.hasEstimate,
          hasEpic: oidsOf(r['Super'])[0] !== undefined,
          hasProject: oidsOf(r['Scope'])[0] !== undefined,
          hasOwnerOrTeam:
            (Array.isArray(r['Owners.Name']) && r['Owners.Name'].length > 0) ||
            str(r['Owners.Name']) !== undefined ||
            str(r['Team.Name']) !== undefined,
          hasPriority: priorityKnown ? oidsOf(r['Priority'])[0] !== undefined : undefined,
        };
        const results = rubric.criteria.map((c) => assess(c, facts));
        scored.push({ type: q.type, row: r, results, summary: summarise(results) });
      }
    }
    // Weakest first; the lowest possible score decides, then the highest, then the number.
    scored.sort(
      (a, b) =>
        a.summary.scoreMin - b.summary.scoreMin ||
        a.summary.scoreMax - b.summary.scoreMax ||
        String(a.row['Number'] ?? '').localeCompare(String(b.row['Number'] ?? '')),
    );
    const capped = scored.slice(0, SCAN_CAP);
    const items = capped.map(({ type, row, results, summary }) => ({
      ...(str(row['Number']) === undefined ? {} : { number: row['Number'] }),
      assetType: type,
      oid: oidsOf(row['_oid'])[0] ?? '',
      ...(str(row['Name']) === undefined ? {} : { name: row['Name'] }),
      ...(summary.score === undefined ? {} : { score: summary.score }),
      scoreMin: summary.scoreMin,
      scoreMax: summary.scoreMax,
      ...(summary.level === undefined ? {} : { level: summary.level }),
      weakest: results.filter((r) => r.score === 0).map((r) => r.id),
      unassessed: summary.unassessed,
    }));
    const levels: Record<string, number> = {};
    for (const i of items) {
      const k = typeof i.level === 'string' ? i.level : 'no_level';
      levels[k] = (levels[k] ?? 0) + 1;
    }

    const notes: string[] = [];
    if (items.length === 0) notes.push('No open stories or defects were found for this target.');
    if (more)
      notes.push(
        `More than ${SCAN_CAP} open items of one type exist: only the first ${SCAN_CAP} of each type, in number order, were read and scored, so this is not the whole sprint or epic.`,
      );
    if (hidden > 0) notes.push('Some items were left out because they are outside the workspace.');
    if (items.some((i) => i.unassessed.length > 0))
      notes.push(
        'Some items have criteria that could not be assessed: their score is a range and a level is named only when the whole range lies in one.',
      );
    if (target.kind === 'epic')
      notes.push('Only the epic’s own backlog items are scored; items below its sub-epics are not read.');
    notes.push(
      'Open items only. Mechanical checks (word counts, key phrases, fields present), not a judgement; use the result to choose what to refine first.',
    );
    const partial = more || hidden > 0;
    const { output } = shapeOutput(ctx, {
      summary: [
        `Quality scan of ${target.kind} `,
        untrusted(target.name ?? target.oid),
        `: ${items.length} open item${items.length === 1 ? '' : 's'} scored with rubric ${rubric.id} ${rubric.version}${more ? ' (more exist)' : ''}.`,
      ],
      notes,
      blocks: [
        {
          title: 'Weakest first',
          source: 'quality scan',
          rows: items.map((i) => ({
            number: i.number,
            assetType: i.assetType,
            oid: i.oid,
            name: i.name,
            score: i.score,
            scoreMin: i.scoreMin,
            scoreMax: i.scoreMax,
            level: i.level,
            weakest: i.weakest.join(', '),
          })),
        },
      ],
      partial,
      structured: {
        sections: [info('ok', ctx.budget.used - used0)],
        rubric: { id: rubric.id, version: rubric.version },
        target,
        scanned: items.length,
        ...(more ? { truncated: true } : {}),
        levels,
        items,
      },
      meta: { queries: queries.map((q) => q.compiled.masked) },
    });
    return output;
  },
});
