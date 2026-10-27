// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { capBudget, type ToolContext } from '../../context.ts';
import { AbError, ErrorCode } from '../../errors.ts';
import { type AssetRef, parseAssetRef } from '../../identity/refs.ts';
import { runQuery } from '../../identity/resolve.ts';
import { metadataFor } from '../../metadata/service.ts';
import { shapeList } from '../../output/result.ts';
import { compileQuery, type FilterInput } from '../../query/compiler.ts';
import { limitError } from '../../query/limits.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { boundedListOutput, formatArg, minimalOutputArg } from '../common.ts';
import { fieldInfo, IDENTITY_FIELDS, toItem } from './rows.ts';

const COST = 16;
const MAX_TYPES = 8;

async function readable(ctx: ToolContext, type: string): Promise<boolean> {
  if (ctx.assetTypes.deny.includes(type)) return false;
  if (ctx.assetTypes.allow !== undefined && !ctx.assetTypes.allow.includes(type)) return false;
  const strategy = await metadataFor(ctx).scopeStrategy(type);
  if (strategy.kind === 'denied') return false;
  return strategy.kind !== 'global' || ctx.assetTypes.allow?.includes(type) === true;
}

export const getAssets: ToolDefinition = defineTool({
  name: 'get_assets',
  title: 'Get assets',
  description:
    'Get assets of any allowed type by number (B-01234, D-00012, TK-00007) or OID token (Story:1234) with chosen fields; numbers not found or not visible are listed in notFound. Not paged. At most 50 per call. Cold call: up to 16 Agility requests.',
  kind: 'read',
  group: 'query',
  // Capped at run time: the prefix sample, metadata per type, one cross-type lookup and one query per type.
  cost: COST,
  inputSchema: z.object({
    assets: z.array(z.string().min(1).max(64)).min(1).max(50).describe('Asset numbers or OID tokens.'),
    fields: z
      .array(z.string().min(1).max(200))
      .max(30)
      .optional()
      .describe('Attribute paths; each type’s default tier when omitted.'),
    minimal_output: minimalOutputArg,
    format: formatArg,
  }),
  outputSchema: boundedListOutput(z.looseObject({ assetType: z.string(), oid: z.string() }), {
    notFound: z.array(z.string()),
  }),
  handler: async (input, outer) => {
    const ctx = { ...outer, budget: capBudget(outer.budget, COST) };
    const md = metadataFor(ctx);
    const refs = input.assets.map((a): [string, AssetRef] => [a, parseAssetRef(a)]);
    // Group what was asked for by asset type; numbers with an unknown or shared prefix go through Workitem first.
    const byType = new Map<string, { oids: Set<string>; numbers: Set<string> }>();
    const group = (type: string) => {
      let g = byType.get(type);
      if (g === undefined) {
        g = { oids: new Set(), numbers: new Set() };
        byType.set(type, g);
      }
      return g;
    };
    const unknown: string[] = [];
    for (const [, ref] of refs) {
      if (ref.kind === 'oid') {
        const meta = await md.findAssetType(ref.assetType);
        if (meta !== undefined && !meta.abstract) group(meta.name).oids.add(ref.oid);
        continue;
      }
      const hinted = await md.typesForPrefix(ref.prefix);
      if (hinted.length === 1) group(hinted[0] as string).numbers.add(ref.number);
      else unknown.push(ref.number);
    }
    if (unknown.length > 0) {
      const compiled = await compileQuery(
        ctx,
        {
          assetType: 'Workitem',
          fields: ['AssetType', 'Number'],
          filters: [{ field: 'Number', op: 'in', value: [...new Set(unknown)] }],
          limit: Math.min(unknown.length, ctx.limits.maxRows),
          includeClosed: true,
        },
        { allowAbstract: true },
      );
      const asked = new Set(unknown.map((n) => n.toUpperCase()));
      for (const r of (await runQuery(ctx, compiled)).rows) {
        if (
          typeof r['AssetType'] === 'string' &&
          typeof r['Number'] === 'string' &&
          asked.has(r['Number'].toUpperCase())
        )
          group(r['AssetType']).numbers.add(r['Number']);
      }
    }
    if (byType.size > MAX_TYPES) throw limitError('maxAssetTypes', MAX_TYPES, 'asset types', byType.size);

    const items: Record<string, unknown>[] = [];
    const notes: string[] = [];
    const richText = new Set<string>();
    const columns = new Set<string>(['number', 'assetType', 'oid', 'state', 'project']);
    for (const [type, wanted] of byType) {
      if (!(await readable(ctx, type))) continue;
      const meta = await md.assetType(type);
      let fields = input.minimal_output === true ? (await md.fieldTiers(type)).minimal : input.fields;
      if (fields !== undefined) {
        const usable: string[] = [];
        for (const f of fields) {
          try {
            usable.push((await md.resolvePath(type, f)).path);
          } catch (error) {
            if (!(error instanceof AbError) || error.code !== ErrorCode.InputInvalid) throw error;
            notes.push(`${type} has no attribute path ${f}; it is left out for ${type}.`);
          }
        }
        fields = usable;
      }
      const filters: FilterInput[] = [];
      const anyOf: FilterInput[][] = [];
      if (wanted.oids.size > 0) anyOf.push([{ field: 'ID', op: 'in', value: [...wanted.oids] }]);
      if (wanted.numbers.size > 0 && meta.attributes.has('Number'))
        anyOf.push([{ field: 'Number', op: 'in', value: [...wanted.numbers] }]);
      if (anyOf.length === 0) continue;
      const compiled = await compileQuery(
        ctx,
        {
          assetType: type,
          ...(fields === undefined ? {} : { fields }),
          filters,
          anyOf: anyOf.length === 1 ? [] : anyOf,
          ...(anyOf.length === 1 ? { filters: anyOf[0] } : {}),
          limit: Math.min(wanted.oids.size + wanted.numbers.size, ctx.limits.maxRows),
          includeClosed: true,
        },
        { identityFields: IDENTITY_FIELDS.filter((f) => meta.attributes.has(f.split('.')[0] as string)) },
      );
      const info = await fieldInfo(ctx, type, compiled.fields);
      for (const f of info.richText) richText.add(f);
      for (const f of compiled.fields) columns.add(f);
      const numbers = new Set([...wanted.numbers].map((n) => n.toUpperCase()));
      for (const r of (await runQuery(ctx, compiled)).rows) {
        // Only the assets that were asked for: an upstream that ignores the filter must not add others (L-122).
        const item = toItem(r, type, compiled.fields, info, compiled.keys);
        const number = typeof item['number'] === 'string' ? item['number'].toUpperCase() : '';
        if (wanted.oids.has(item['oid'] as string) || numbers.has(number)) items.push(item);
      }
    }
    const found = new Set(
      items.flatMap((i) => [i['oid'], i['number']].filter((x): x is string => typeof x === 'string')),
    );
    const notFound = refs
      .filter(([, ref]) => !found.has(ref.kind === 'oid' ? ref.oid : ref.number))
      .map(([text]) => text);
    if (notFound.length > 0)
      notes.push(
        `${notFound.length} not found or not visible with this token (also when outside the workspace).`,
      );
    const output = shapeList(ctx, {
      summary: `${items.length} of ${refs.length} asset${refs.length === 1 ? '' : 's'} found.`,
      notes,
      source: 'assets',
      rows: items,
      columns: [...columns],
      richText: [...richText],
      ...(input.format === undefined ? {} : { format: input.format }),
    });
    return { ...output, structured: { ...(output.structured as Record<string, unknown>), notFound } };
  },
});
