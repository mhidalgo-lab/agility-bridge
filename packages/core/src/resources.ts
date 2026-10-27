// SPDX-License-Identifier: Apache-2.0
// MCP resources (P6-09): reference material the agent reads on demand, registered from one manifest (L-153) and served
// through the tool handlers, so every read has the same request budget, limits, metadata cache, scope rules, output
// shaping (untrusted-data envelope) and audit as the tool call it stands for. A resource never reaches Agility itself.
import type { ToolContext } from './context.ts';
import { AbError, ErrorCode } from './errors.ts';
import { assertManifest, type ManifestEntry } from './manifest.ts';
import { shapeOutput } from './output/result.ts';
import { FILTER_OPS } from './query/compiler.ts';
import { QUALITY_RECIPE_RESOURCES } from './recipes/quality.ts';
import { OTHER_ASSET_RECIPES } from './recipes/other-assets.ts';
import { BACKLOG_ITEM_QUALITY_RUBRIC } from './rubric.ts';
import type { ToolOutput } from './tool.ts';

export const RESOURCE_SCHEME = 'agility-bridge://';

/** What a reader gets: the per-request context and a way to run the tools the entry declares, nothing else. */
export interface ResourceReader {
  readonly ctx: ToolContext;
  /** Runs a declared, allowed tool's handler with its schema applied; any other tool name throws. */
  run(tool: string, input?: Record<string, unknown>): Promise<ToolOutput>;
}

/** The body of one resource. `text` already carries the envelope for every Agility string in it. */
export interface ResourceBody {
  readonly text: string;
  readonly meta?: Record<string, unknown>;
}

/** One concrete URI a template stands for (`resources/list`). */
export interface ListedResource {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
}

export interface ResourceDefinition extends ManifestEntry {
  /** A URI, or a URI template (`{variable}`) with `list` enumerating the concrete URIs. */
  readonly uri: string;
  readonly title: string;
  /** Written for agents; static (never instance words, THREAT_MODEL A12). */
  readonly description: string;
  readonly mimeType: string;
  /** Who produces the content, for the generated reference. */
  readonly source: 'static' | 'tool';
  readonly read: (
    reader: ResourceReader,
    variables: Readonly<Record<string, string>>,
  ) => Promise<ResourceBody>;
  /** Templates only: the URIs readable for this caller, built from the same tool output the read uses. */
  readonly list?: (reader: ResourceReader) => Promise<readonly ListedResource[]>;
}

export const isTemplate = (def: Pick<ResourceDefinition, 'uri'>): boolean => def.uri.includes('{');

/** Asset type names reach a URI only when they are plain identifiers (they come from instance metadata, A12). */
const TYPE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const OP_HELP: Record<(typeof FILTER_OPS)[number], string> = {
  eq: 'equals (text, number, boolean, date, or a relation by name or OID).',
  ne: 'does not equal.',
  lt: 'less than (numbers and dates).',
  le: 'less than or equal (numbers and dates).',
  gt: 'greater than (numbers and dates).',
  ge: 'greater than or equal (numbers and dates).',
  contains: 'text attributes only: the value appears inside the text.',
  in: 'one of several values: `value` is an array (at most 50).',
  is_set: 'the attribute has a value; omit `value`.',
  is_not_set: 'the attribute is empty; omit `value`.',
};

const FILTERS_TEXT = [
  '# Structured filter vocabulary',
  '',
  'Used by `query_assets` (`filters` and `any_of`). Every value is bound as a parameter: never build a query string.',
  '',
  '## Filter',
  '',
  'A filter is `{ "field": <attribute path>, "op": <operator>, "value": <scalar or array> }`. The field is an attribute path of the',
  'asset type (`Name`, `Status.Name`, `Owners.Name`, `Scope.Name`, `Estimate`); `describe_asset_type` lists the paths. Relation hops are limited by the workspace.',
  '',
  '## Operators',
  '',
  ...FILTER_OPS.map((op) => `- \`${op}\`: ${OP_HELP[op]}`),
  '',
  '## Combining',
  '',
  '- `filters` are ANDed.',
  '- `any_of` is a list of groups: groups are ORed, filters inside a group are ANDed; the whole set is ANDed with `filters`.',
  '',
  '## Examples',
  '',
  '```json',
  '{ "asset_type": "Defect", "filters": [{ "field": "Status.Name", "op": "eq", "value": "In Progress" }] }',
  '{ "asset_type": "Story", "filters": [{ "field": "Estimate", "op": "ge", "value": 5 }, { "field": "Owners", "op": "is_not_set" }] }',
  '{ "asset_type": "Story", "any_of": [[{ "field": "Name", "op": "contains", "value": "login" }], [{ "field": "Priority.Name", "op": "in", "value": ["High", "Critical"] }]] }',
  '```',
  '',
  '## Also',
  '',
  '- `sort`: `[{ "field": "ChangeDate", "direction": "desc" }]` (at most 3; `ID` is always the last tiebreaker).',
  '- `project` narrows to one allowed project; `as_of` reads a past point in time (bounded by the workspace).',
  '- Closed assets are excluded unless `include_closed` is true; dead assets never appear.',
  '- Paging: pass `nextCursor` back as `cursor` with the same arguments.',
  '',
].join('\n');

/** One page per request budget unit is fine here; a tree of more projects than this says so and stops. */
const MAX_PROJECT_PAGES = 5;

interface ProjectItem {
  readonly oid: string;
  readonly name?: unknown;
  readonly state?: unknown;
  readonly parent?: { readonly oid: string };
  readonly schedule?: unknown;
}

async function projectTree(reader: ResourceReader): Promise<ResourceBody> {
  const { ctx } = reader;
  const items: ProjectItem[] = [];
  let cursor: string | undefined;
  let more = false;
  for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
    const out = await reader.run('list_projects', {
      limit: ctx.limits.maxRows,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const s = (out.structured ?? {}) as { items?: ProjectItem[]; nextCursor?: string };
    items.push(...(s.items ?? []));
    cursor = s.nextCursor;
    if (cursor === undefined) break;
    more = page === MAX_PROJECT_PAGES - 1;
  }
  const byParent = new Map<string, ProjectItem[]>();
  const known = new Set(items.map((i) => i.oid));
  const roots: ProjectItem[] = [];
  for (const item of items) {
    const parent = item.parent?.oid;
    if (parent === undefined || !known.has(parent)) roots.push(item);
    else byParent.set(parent, [...(byParent.get(parent) ?? []), item]);
  }
  const rows: Record<string, unknown>[] = [];
  const walk = (item: ProjectItem, depth: number): void => {
    if (depth > 20) return;
    rows.push({
      depth,
      oid: item.oid,
      name: item.name,
      state: item.state,
      ...(item.schedule === undefined ? {} : { schedule: item.schedule }),
    });
    for (const child of byParent.get(item.oid) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  const { output } = shapeOutput(ctx, {
    summary: `${rows.length} Agility project${rows.length === 1 ? '' : 's'} this workspace allows, as a tree (depth 0 is a top level project).`,
    notes: more
      ? [`Only the first ${items.length} projects are shown; use list_projects with contains to find others.`]
      : [],
    blocks: [
      {
        source: 'Agility projects',
        rows,
        columns: ['depth', 'oid', 'name', 'state', 'schedule'],
      },
    ],
    caps: { maxRows: Math.max(1, rows.length) },
    ...(more ? { partial: true } : {}),
  });
  return { text: output.text, ...(output.meta === undefined ? {} : { meta: output.meta }) };
}

const viaTool =
  (tool: string, input: (variables: Readonly<Record<string, string>>) => Record<string, unknown>) =>
  async (reader: ResourceReader, variables: Readonly<Record<string, string>>): Promise<ResourceBody> => {
    const out = await reader.run(tool, input(variables));
    return { text: out.text, ...(out.meta === undefined ? {} : { meta: out.meta }) };
  };

/**
 * The resource manifest (docs/reference/tool-catalogue.md, "Resources"). Prompts (P6-08) register from the same
 * manifest module; recipe resources (P6-03, P6-06) are entries here. `uses` are the tools that serve the entry: the
 * entry exists only when all of them are allowed. Static entries still name the tool they describe, so a caller that
 * cannot use the tool is not shown its vocabulary.
 */
export const RESOURCE_MANIFEST: readonly ResourceDefinition[] = Object.freeze([
  {
    id: 'reference_filters',
    uri: `${RESOURCE_SCHEME}reference/filters`,
    title: 'Structured filter vocabulary',
    description:
      'Cheat sheet of the structured filter vocabulary (operators, combining, sort, examples) used by query_assets.',
    mimeType: 'text/markdown',
    source: 'static',
    uses: ['query_assets'],
    read: async () => ({ text: FILTERS_TEXT }),
  },
  {
    id: 'instance_asset_types',
    uri: `${RESOURCE_SCHEME}instance/asset-types`,
    title: 'Asset types of the instance',
    description:
      'The asset types this workspace allows on the instance, with base type, number prefix and scope strategy (the output of list_asset_types, as a snapshot).',
    mimeType: 'text/plain',
    source: 'tool',
    uses: ['list_asset_types'],
    read: viaTool('list_asset_types', () => ({})),
  },
  {
    id: 'instance_asset_type',
    uri: `${RESOURCE_SCHEME}instance/asset-types/{asset_type}`,
    title: 'One asset type',
    description:
      'Attributes, operations, statuses and field tiers of one asset type (the output of describe_asset_type).',
    mimeType: 'text/plain',
    source: 'tool',
    uses: ['describe_asset_type', 'list_asset_types'],
    read: viaTool('describe_asset_type', (v) => ({ asset_type: v['asset_type'] ?? '' })),
    list: async (reader) => {
      const out = await reader.run('list_asset_types', {});
      const items = ((out.structured ?? {}) as { items?: Array<{ assetType?: unknown }> }).items ?? [];
      return items.flatMap((i) =>
        typeof i.assetType === 'string' && TYPE_NAME_RE.test(i.assetType)
          ? [{ uri: `${RESOURCE_SCHEME}instance/asset-types/${i.assetType}`, name: i.assetType }]
          : [],
      );
    },
  },
  {
    id: 'workspace_projects',
    uri: `${RESOURCE_SCHEME}workspace/projects`,
    title: 'Agility projects of this workspace',
    description: 'The Agility projects this workspace allows, as a tree (built from list_projects).',
    mimeType: 'text/plain',
    source: 'tool',
    uses: ['list_projects'],
    read: projectTree,
  },
  {
    id: 'rubric_backlog_item_quality',
    uri: `${RESOURCE_SCHEME}rubrics/backlog-item-quality`,
    title: 'Backlog item quality rubric',
    description:
      'The versioned rubric (JSON) for judging backlog items: criteria, weights, scale and levels. work_item_quality uses the same rubric.',
    mimeType: 'application/json',
    source: 'static',
    uses: ['get_work_item'],
    read: async () => ({ text: JSON.stringify(BACKLOG_ITEM_QUALITY_RUBRIC, null, 2) }),
  },
  // Quality recipes (P6-03): a separate block, kept in recipes/quality.ts.
  ...QUALITY_RECIPE_RESOURCES,
  ...OTHER_ASSET_RECIPES,
] satisfies ResourceDefinition[]);

assertManifest(RESOURCE_MANIFEST);

/** An AbError for a resource whose tool is not available or a variable that is missing: read as "not found". */
export function resourceUnavailable(what: string): AbError {
  return new AbError(ErrorCode.NotFound, `Resource ${what} is not available in this workspace.`);
}
