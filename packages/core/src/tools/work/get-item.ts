// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { agilityClient } from '../../agility/client.ts';
import { capBudget } from '../../context.ts';
import { resolveAsset } from '../../identity/resolve.ts';
import { inScope, oidsOf, sanitizeRow } from '../../identity/scope.ts';
import { metadataFor } from '../../metadata/service.ts';
import { shapeOutput, untrusted } from '../../output/result.ts';
import { type CompiledQuery, compileQuery } from '../../query/compiler.ts';
import { invalid } from '../../query/limits.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { assetArg, formatArg, isAcceptanceAttribute, skipRelatedArg } from '../common.ts';
import { identityFor, workItem, workItemFields } from './items.ts';

const COST = 24;
const MAX_CHILDREN = 20;
const MAX_LINKS = 20;
const MAX_COMMENTS = 50;

type Row = Record<string, unknown>;

export const getWorkItem: ToolDefinition = defineTool({
  name: 'get_work_item',
  title: 'Get a work item',
  description:
    'Get one work item (backlog item, defect, task, test or epic) by number or OID token with description and acceptance criteria as text, owners, status, sprint, parent, epic, child tasks and tests, links and comment count. Not paged. Children and links are capped at 20 each. Cold call: up to 24 Agility requests.',
  kind: 'read',
  group: 'work',
  // Capped at run time: resolution, metadata for the item, its relations and child types (cold cache), one batch.
  cost: COST,
  inputSchema: z.object({
    asset: assetArg,
    skip_related: skipRelatedArg,
    format: formatArg,
  }),
  outputSchema: z.looseObject({
    item: z.looseObject({ assetType: z.string(), oid: z.string() }),
    children: z.array(z.looseObject({ assetType: z.string(), oid: z.string() })),
    links: z.array(z.looseObject({ oid: z.string() })),
    partial: z.boolean().optional(),
    notes: z.array(z.string()).optional(),
  }),
  handler: async (input, outer) => {
    const ctx = { ...outer, budget: capBudget(outer.budget, COST) };
    const md = metadataFor(ctx);
    const target = await resolveAsset(ctx, input.asset);
    if (!(await md.isA(target.assetType, 'Workitem'))) {
      throw invalid(`${target.assetType} is not a work item.`, 'Use get_assets for other asset types.');
    }
    const meta = await md.assetType(target.assetType);
    const has = (a: string) => meta.attributes.has(a.split('.')[0] as string);
    const acceptance = [...meta.attributes.values()].find(
      (a) => isAcceptanceAttribute(a.name) && a.kind === 'LongText',
    )?.name;
    const fields = [
      ...(await workItemFields(ctx, target.assetType)),
      ...[
        'Description',
        'Super',
        'Super.Number',
        'Super.Name',
        'Parent',
        'Parent.Number',
        'Parent.Name',
        'CreateDateUTC',
      ].filter(has),
      ...(acceptance === undefined ? [] : [acceptance]),
    ];
    const queries: Array<{ key: string; compiled: CompiledQuery }> = [];
    const skipped: string[] = [];
    const add = async (key: string, type: string, f: string[], filter: string, limit: number) => {
      if ((await md.findAssetType(type)) === undefined) return;
      // A section the workspace does not allow is left out with a note, never fails the item (review M4).
      const denied =
        ctx.assetTypes.deny.includes(type) ||
        (ctx.assetTypes.allow !== undefined && !ctx.assetTypes.allow.includes(type));
      if (key !== 'item' && denied) {
        skipped.push(type);
        return;
      }
      queries.push({
        key,
        compiled: await compileQuery(
          ctx,
          {
            assetType: type,
            fields: f,
            filters: [{ field: filter, op: 'eq', value: target.oid }],
            limit,
            includeClosed: true,
          },
          { identityFields: await identityFor(type, ctx) },
        ),
      });
    };
    await add('item', target.assetType, fields, 'ID', 1);
    if (input.skip_related !== true) {
      if (await md.isA(target.assetType, 'PrimaryWorkitem')) {
        await add('tasks', 'Task', await workItemFields(ctx, 'Task'), 'Parent', MAX_CHILDREN);
        await add('tests', 'Test', await workItemFields(ctx, 'Test'), 'Parent', MAX_CHILDREN);
      }
      await add('links', 'Link', ['Name', 'URL'], 'Asset', MAX_LINKS);
      await add('comments', 'Expression', ['AuthoredAt'], 'Mentions', MAX_COMMENTS);
    }
    const res = await agilityClient(ctx).query<unknown[]>(queries.map((q) => q.compiled.body));
    const results = new Map<string, { rows: Row[]; more: boolean }>();
    for (const [i, q] of queries.entries()) {
      const set = Array.isArray(res.data) ? res.data[i] : undefined;
      const rows = (Array.isArray(set) ? set : []).filter(
        (r): r is Row => r !== null && typeof r === 'object' && !Array.isArray(r),
      );
      const kept = rows.filter((r) => inScope(ctx, q.compiled, r));
      for (const r of kept) sanitizeRow(ctx, q.compiled, r);
      results.set(q.key, { rows: kept.slice(0, q.compiled.limit), more: kept.length > q.compiled.limit });
    }
    const row = results.get('item')?.rows[0];
    if (row === undefined) throw invalid(`${input.asset} changed while it was read; try again.`);
    const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
    const ref = (field: string) => {
      const oid = oidsOf(row[field])[0];
      return oid === undefined
        ? undefined
        : {
            oid,
            ...(str(row[`${field}.Number`]) ? { number: row[`${field}.Number`] } : {}),
            ...(str(row[`${field}.Name`]) ? { name: row[`${field}.Name`] } : {}),
          };
    };
    const item: Record<string, unknown> = {
      ...workItem(target.assetType, row),
      ...(str(row['Description']) ? { description: row['Description'] } : {}),
      ...(acceptance !== undefined && str(row[acceptance]) ? { acceptanceCriteria: row[acceptance] } : {}),
      ...(ref('Super') === undefined ? {} : { epic: ref('Super') }),
      ...(ref('Parent') === undefined ? {} : { parent: ref('Parent') }),
    };
    const children = [
      ...(results.get('tasks')?.rows ?? []).map((r) => workItem('Task', r)),
      ...(results.get('tests')?.rows ?? []).map((r) => workItem('Test', r)),
    ];
    const links = (results.get('links')?.rows ?? []).map((r) => ({
      oid: oidsOf(r['_oid'])[0] ?? '',
      ...(str(r['Name']) ? { name: r['Name'] } : {}),
      ...(str(r['URL']) ? { url: r['URL'] } : {}),
    }));
    const comments = results.get('comments');
    const notes: string[] = [];
    let partial = false;
    if (results.get('tasks')?.more || results.get('tests')?.more) {
      partial = true;
      notes.push(
        `Only the first ${MAX_CHILDREN} child tasks and tests of each kind are shown; use search_work_items for the rest.`,
      );
    }
    if (results.get('links')?.more) {
      partial = true;
      notes.push(`Only the first ${MAX_LINKS} links are shown.`);
    }
    if (comments?.more) notes.push(`More than ${MAX_COMMENTS} comments.`);
    if (acceptance === undefined)
      notes.push('This instance has no acceptance-criteria attribute on this type.');
    if (skipped.length > 0) notes.push(`Not shown, not allowed in this workspace: ${skipped.join(', ')}.`);
    if (input.skip_related === true) notes.push('Children, links and comments were skipped (skip_related).');
    const commentCount = comments === undefined ? undefined : comments.rows.length;
    const details = Object.entries(item)
      .filter(([k]) => k !== 'description' && k !== 'acceptanceCriteria')
      .map(([field, value]) => ({ field, value }));
    const { output, blocks } = shapeOutput(ctx, {
      summary: [`${target.assetType} ${String(item['number'] ?? target.oid)}: `, untrusted(item['name'])],
      notes,
      blocks: [
        { title: 'Item', source: 'work item', rows: details },
        {
          title: 'Description',
          source: 'description',
          rows: item['description'] === undefined ? [] : [{ description: item['description'] }],
          richText: ['description'],
        },
        ...(item['acceptanceCriteria'] === undefined
          ? []
          : [
              {
                title: 'Acceptance criteria',
                source: 'acceptance criteria',
                rows: [{ acceptanceCriteria: item['acceptanceCriteria'] }],
                richText: ['acceptanceCriteria'],
              },
            ]),
        {
          title: 'Children',
          source: 'child work items',
          rows: children,
          columns: ['number', 'assetType', 'oid', 'state', 'name', 'status', 'owners', 'toDoHours'],
        },
        { title: 'Links', source: 'links', rows: links },
      ],
      partial,
      caps: { maxValueChars: 4_000, maxRows: MAX_CHILDREN * 2 },
      ...(input.format === undefined ? {} : { format: input.format }),
      meta: { queries: queries.map((q) => q.compiled.masked) },
    });
    const shownItem = { ...item };
    const desc = blocks[1]?.rows[0]?.['description'];
    if (desc !== undefined) shownItem['description'] = desc;
    const ac = blocks.find((b) => b.columns.includes('acceptanceCriteria'))?.rows[0]?.['acceptanceCriteria'];
    if (ac !== undefined) shownItem['acceptanceCriteria'] = ac;
    const childBlock = blocks.find((b) => b.columns.includes('toDoHours'));
    const linkBlock = blocks.at(-1);
    return {
      ...output,
      structured: {
        ...(output.structured as Record<string, unknown>),
        item:
          blocks[0] === undefined
            ? shownItem
            : { ...shownItem, ...Object.fromEntries(blocks[0].rows.map((r) => [r['field'], r['value']])) },
        children: (childBlock?.rows ?? []) as Array<{ assetType: string; oid: string }>,
        links: (linkBlock?.rows ?? []) as Array<{ oid: string }>,
        ...(commentCount === undefined ? {} : { commentCount }),
      },
    };
  },
});
