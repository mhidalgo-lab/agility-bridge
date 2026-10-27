// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { ToolContext } from '../../context.ts';
import { AbError, ErrorCode } from '../../errors.ts';
import { metadataFor } from '../../metadata/service.ts';
import { shapeList, shapeOutput } from '../../output/result.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { assetTypeArg, boundedListOutput, containsArg, formatArg } from '../common.ts';

/** Product types offered when the workspace has no allow list (ARCHITECTURE §6.3). */
export const DEFAULT_READABLE_TYPES: readonly string[] = Object.freeze([
  'Story',
  'Defect',
  'Task',
  'Test',
  'TestSet',
  'Epic',
  'Theme',
  'Issue',
  'Request',
  'Goal',
  'RegressionTest',
  'Scope',
  'Timebox',
  'Member',
  'Team',
  'Attachment',
  'Link',
  'Actual',
  'Expression',
]);

/** Whether the workspace lets the caller see this type at all (negative authorization: hidden and refused). */
export function typeAllowed(ctx: ToolContext, type: string): boolean {
  if (ctx.assetTypes.deny.includes(type)) return false;
  return ctx.assetTypes.allow === undefined || ctx.assetTypes.allow.includes(type);
}

export const listAssetTypes: ToolDefinition = defineTool({
  name: 'list_asset_types',
  title: 'List asset types',
  description:
    'List the asset types you can query in this workspace, with base type, number prefix and scope strategy. Not paged. Cold call: up to 24 Agility requests (metadata per type); later calls use the cache.',
  kind: 'read',
  group: 'core',
  // One meta.v1 load per candidate type and its bases, plus the number-prefix sample (cold cache).
  cost: 24,
  inputSchema: z.object({ contains: containsArg('asset types'), format: formatArg }),
  outputSchema: boundedListOutput(
    z.looseObject({
      assetType: z.string(),
      base: z.string().optional(),
      prefix: z.string().optional(),
      scopeStrategy: z.string(),
    }),
  ),
  handler: async (input, ctx) => {
    const md = metadataFor(ctx);
    const candidates = (ctx.assetTypes.allow ?? DEFAULT_READABLE_TYPES).filter((t) => typeAllowed(ctx, t));
    const wanted = input.contains?.toLowerCase();
    const prefixes = await md.numberPrefixes();
    const items: Record<string, unknown>[] = [];
    for (const t of candidates) {
      if (wanted !== undefined && !t.toLowerCase().includes(wanted)) continue;
      const meta = await md.findAssetType(t);
      if (meta === undefined || meta.abstract) continue;
      const strategy = await md.scopeStrategy(t);
      if (strategy.kind === 'denied') continue;
      items.push({
        assetType: meta.name,
        ...(meta.base === undefined ? {} : { base: meta.base }),
        ...(prefixes.get(meta.name) === undefined ? {} : { prefix: `${prefixes.get(meta.name)}-` }),
        scopeStrategy: strategy.kind,
        ...(strategy.kind === 'derived' ? { scopePath: strategy.path } : {}),
      });
    }
    return shapeList(ctx, {
      summary: `${items.length} asset type${items.length === 1 ? '' : 's'} readable in this workspace.`,
      notes: ['Global types (members, teams) are read through their dedicated tools.'],
      source: 'asset types',
      rows: items,
      columns: ['assetType', 'base', 'prefix', 'scopeStrategy', 'scopePath'],
      ...(input.format === undefined ? {} : { format: input.format }),
    });
  },
});

export const describeAssetType: ToolDefinition = defineTool({
  name: 'describe_asset_type',
  title: 'Describe an asset type',
  description:
    'Describe one asset type on this instance: its fields (attributes with type, relation target, multi-value, custom, read-only, required), operations, statuses and the minimal/default/full field tiers other tools use. Not paged.',
  kind: 'read',
  group: 'core',
  // The type, its bases or derived scope path, and its status list type and statuses (cold cache).
  cost: 5,
  inputSchema: z.object({
    asset_type: assetTypeArg,
    contains: containsArg('attributes'),
    format: formatArg,
  }),
  outputSchema: z.looseObject({
    assetType: z.string(),
    scopeStrategy: z.string(),
    attributes: z.array(z.looseObject({ name: z.string(), kind: z.string() })),
    operations: z.array(z.string()),
    statuses: z.array(z.looseObject({ oid: z.string(), name: z.string() })),
    tiers: z.looseObject({
      minimal: z.array(z.string()),
      default: z.array(z.string()),
      full: z.array(z.string()),
    }),
  }),
  handler: async (input, ctx) => {
    const md = metadataFor(ctx);
    const refused = () =>
      new AbError(
        ErrorCode.AuthForbidden,
        `Asset type ${input.asset_type} is not available in this workspace.`,
        {
          hint: 'list_asset_types shows the types you can read.',
        },
      );
    if (!typeAllowed(ctx, input.asset_type)) throw refused();
    const meta = await md.assetType(input.asset_type);
    const strategy = await md.scopeStrategy(meta.name);
    if (strategy.kind === 'denied' && !meta.abstract) throw refused();
    const wanted = input.contains?.toLowerCase();
    const attributes = [...meta.attributes.values()]
      .filter((a) => wanted === undefined || a.name.toLowerCase().includes(wanted))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => ({
        name: a.name,
        kind: a.kind,
        ...(a.relatedType === undefined ? {} : { relatedType: a.relatedType }),
        multi: a.multi,
        custom: a.custom,
        readOnly: a.readOnly,
        required: a.required,
      }));
    const statuses = meta.attributes.get('Status')?.kind === 'Relation' ? await md.statuses(meta.name) : [];
    const tiers = meta.abstract ? { minimal: [], default: [], full: [] } : await md.fieldTiers(meta.name);
    const operations = [...meta.operations].sort();
    const { output, blocks } = shapeOutput(ctx, {
      summary: `${meta.name}${meta.base === undefined ? '' : ` (a ${meta.base})`}: ${attributes.length} attribute${attributes.length === 1 ? '' : 's'}${wanted === undefined ? '' : ' matching'}, ${operations.length} operations, ${statuses.length} statuses; scope: ${strategy.kind}.`,
      notes: meta.abstract ? ['Abstract type: query one of its concrete subtypes.'] : [],
      blocks: [
        {
          title: 'Attributes',
          source: 'asset type attributes',
          rows: attributes,
          columns: ['name', 'kind', 'relatedType', 'multi', 'custom', 'readOnly', 'required'],
        },
        {
          title: 'Statuses',
          source: 'statuses',
          rows: statuses.map((s) => ({ ...s })),
          columns: ['oid', 'name', 'category', 'inactive', 'team'],
        },
        { title: 'Operations', source: 'operations', rows: operations.map((name) => ({ name })) },
      ],
      caps: { maxRows: 400 },
      ...(input.format === undefined ? {} : { format: input.format }),
    });
    const [attrBlock, statusBlock] = blocks;
    return {
      ...output,
      structured: {
        ...(output.structured as Record<string, unknown>),
        assetType: meta.name,
        ...(meta.base === undefined ? {} : { base: meta.base }),
        abstract: meta.abstract,
        scopeStrategy: strategy.kind,
        attributes: (attrBlock?.rows ?? []) as typeof attributes,
        operations,
        statuses: (statusBlock?.rows ?? []) as Array<{ oid: string; name: string }>,
        tiers: { minimal: [...tiers.minimal], default: [...tiers.default], full: [...tiers.full] },
      },
    };
  },
});
