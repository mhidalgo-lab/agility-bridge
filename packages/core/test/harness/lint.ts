// SPDX-License-Identifier: Apache-2.0
// The tool lints (tool conventions, "Lints"; P1-13): naming, descriptions, schemas. Pure functions over a tool and its
// advertised JSON Schemas, so each refused example of the conventions is a test case.
import { type ToolDefinition, withCachedJsonSchema } from '../../src/index.ts';
import { ARGUMENT_VOCABULARY } from '../../src/tools/common.ts';

export interface Violation {
  readonly tool: string;
  readonly rule: string;
  readonly detail: string;
}

/** Verbs a tool name may start with (reads, then writes); reports are nouns and listed explicitly. */
const VERBS = [
  'list',
  'search',
  'get',
  'query',
  'describe',
  'add',
  'update',
  'create',
  'log',
  'assign',
  'move',
  'close',
  'reopen',
];
const NOUN_TOOLS = new Set([
  'whoami',
  'sprint_health',
  'standup_summary',
  'release_readiness',
  'defect_triage',
  'quality_scan',
  'work_item_quality',
]);
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** Refused argument names and their replacement (one name per concept, L-030). */
export const REFUSED_ARGUMENTS: Readonly<Record<string, string>> = Object.freeze({
  id: 'asset',
  oid: 'asset',
  number: 'asset',
  guid: 'asset',
  scope: 'project',
  iteration: 'sprint',
  timebox: 'sprint',
  owner: 'member',
  assignee: 'member',
  page: 'limit/cursor',
  page_size: 'limit',
  pagesize: 'limit',
  next_cursor: 'cursor',
  max_results: 'limit',
  since: 'time_range',
  until: 'time_range',
  window: 'time_range',
  where: 'filters',
  filter_expression: 'filters',
  query: 'filters',
  oql: 'filters',
  raw: 'filters',
});

export function lintToolName(name: string): string[] {
  const out: string[] = [];
  if (!SNAKE.test(name)) out.push('not snake_case');
  if (/_(?:v\d+|new|old|next|legacy)$/.test(name)) out.push('version or novelty suffix');
  if (!NOUN_TOOLS.has(name) && !VERBS.some((v) => name === v || name.startsWith(`${v}_`)))
    out.push(`must start with one of: ${VERBS.join(', ')}`);
  return out;
}

export function lintArgumentName(name: string): string[] {
  const out: string[] = [];
  if (!SNAKE.test(name)) out.push('not snake_case');
  const replacement = REFUSED_ARGUMENTS[name.toLowerCase()];
  if (replacement !== undefined) out.push(`use ${replacement}`);
  if (/_(?:h|d|m|s|ms)$/.test(name) && !/_ms$/.test(name))
    out.push('unit abbreviation: use _hours, _days, _minutes');
  return out;
}

/** A literal default typed into prose ("default 25", "(default: false)"): defaults come from the schema (L-150). */
const TYPED_DEFAULT =
  /\bdefaults?\b\s*(?:is|to|of|:)?\s*(?:`[^`]+`|"[^"]+"|'[^']+'|\d[\d,_.]*\b|true\b|false\b|on\b|off\b|none\b|all\b|id\b|me\b|auto\b)|\(\s*default\b/i;

/** Words that only exist on some instance: custom attributes, hosts, customer names (THREAT_MODEL A12). */
const INSTANCE_WORDS = /Custom_|v1host\.com|\.example\.com/;

export function lintDescription(tool: Pick<ToolDefinition, 'description' | 'kind' | 'cost'>): string[] {
  const d = tool.description;
  const out: string[] = [];
  if (/^\s*(?:This tool|Use this|A tool)\b/i.test(d)) out.push('start with the action');
  if (d.length > 450) out.push(`${d.length} characters (at most 450)`);
  if (!/Paged: pass nextCursor back as cursor\.|Not paged\./.test(d)) out.push('say whether it is paged');
  if (tool.kind !== 'read' && !d.includes('Changes Agility. Needs approval.'))
    out.push('write tools say "Changes Agility. Needs approval."');
  // One sentence for the cost, in the same words everywhere (P6-12).
  if (tool.cost >= 8 && !d.includes(`Cold call: up to ${tool.cost} Agility requests`))
    out.push(`state the cost as "Cold call: up to ${tool.cost} Agility requests"`);
  if (tool.cost < 8 && /Agility requests/.test(d)) out.push('state the cost only when it reaches 8 requests');
  // Imperative opening: "Get …", never "What changed …", "Returns …" or "Lists …".
  const first = /^\s*([A-Za-z]+)/.exec(d)?.[1] ?? '';
  if (/^(?:What|Which|Who|The|A|An|It|This)$/i.test(first) || /[^s]s$/.test(first))
    out.push(`start with an imperative verb, not "${first}"`);
  if (TYPED_DEFAULT.test(d)) out.push('typed default: put it in the schema');
  if (INSTANCE_WORDS.test(d)) out.push('instance-specific word (THREAT_MODEL A12)');
  return out;
}

type Json = Record<string, unknown>;

function walk(schema: unknown, visit: (node: Json, path: string) => void, path = '$'): void {
  if (Array.isArray(schema)) {
    for (const [i, s] of schema.entries()) walk(s, visit, `${path}[${i}]`);
    return;
  }
  if (schema === null || typeof schema !== 'object') return;
  visit(schema as Json, path);
  for (const [k, v] of Object.entries(schema)) walk(v, visit, `${path}.${k}`);
}

export function advertisedSchemas(tool: ToolDefinition): { input: Json; output?: Json } {
  // What tools/list advertises: the cached input-side conversion (optional with a default, $schema dropped).
  const input = withCachedJsonSchema(tool.inputSchema as never)['~standard'].jsonSchema.input({
    target: 'draft-2020-12',
  }) as Json;
  const output =
    tool.outputSchema === undefined
      ? undefined
      : (withCachedJsonSchema(tool.outputSchema as never)['~standard'].jsonSchema.output({
          target: 'draft-2020-12',
        }) as Json);
  return { input, ...(output === undefined ? {} : { output }) };
}

export function lintSchemas(tool: ToolDefinition): string[] {
  const out: string[] = [];
  const { input, output } = advertisedSchemas(tool);
  for (const [which, schema] of [
    ['input', input],
    ['output', output],
  ] as const) {
    walk(schema, (node, path) => {
      if (Array.isArray(node['type'])) out.push(`${which} ${path}: type array`);
      if (node['nullable'] !== undefined) out.push(`${which} ${path}: nullable`);
      if (which === 'output' && node['additionalProperties'] === false)
        out.push(`output ${path}: closed object`);
      if (typeof node['description'] === 'string' && TYPED_DEFAULT.test(node['description']))
        out.push(`${which} ${path}: typed default in a description`);
    });
  }
  const props = (input['properties'] ?? {}) as Record<string, Json>;
  for (const [name, prop] of Object.entries(props)) {
    for (const v of lintArgumentName(name)) out.push(`argument ${name}: ${v}`);
    if (name === 'limit' && !(typeof prop['maximum'] === 'number' && prop['maximum'] <= 1_000))
      out.push('limit has no maximum of at most 1000');
  }
  if (props['cursor'] !== undefined) {
    const outProps = (output?.['properties'] ?? {}) as Record<string, unknown>;
    if (outProps['nextCursor'] === undefined) out.push('takes cursor but returns no nextCursor');
  }
  const outProps = (output?.['properties'] ?? {}) as Record<string, unknown>;
  if (
    outProps['items'] !== undefined &&
    outProps['nextCursor'] === undefined &&
    outProps['truncated'] === undefined
  ) {
    out.push('list output without nextCursor or truncated');
  }
  const filters = JSON.stringify(props['filters'] ?? props['any_of'] ?? {});
  if (props['filters'] !== undefined && !/no commas/i.test(filters))
    out.push('filter values must state the no-comma rule');
  return out;
}

/** Title words that stay capitalised after the first (proper names and acronyms). */
const TITLE_PROPER = new Set(['Agility', 'UTC', 'OID', 'ID', 'API', 'I']);

/** A title is sentence case, short, without a final period, and a verb tool's title starts with its verb. */
export function lintTitle(tool: Pick<ToolDefinition, 'name' | 'title'>): string[] {
  const out: string[] = [];
  const words = tool.title.trim().split(/\s+/);
  if (tool.title !== tool.title.trim() || tool.title.length === 0) out.push('empty or padded title');
  if (tool.title.length > 40) out.push(`${tool.title.length} characters (at most 40)`);
  if (/[.:;!?]$/.test(tool.title)) out.push('no final punctuation');
  if (!/^[A-Z]/.test(words[0] ?? '')) out.push('start with a capital letter');
  for (const w of words.slice(1))
    if (/^[A-Z]/.test(w) && !TITLE_PROPER.has(w)) out.push(`sentence case: "${w}"`);
  const verb = tool.name.split('_')[0] ?? '';
  if (VERBS.includes(verb) && words[0]?.toLowerCase() !== verb)
    out.push(`a ${verb}_ tool's title starts with "${verb[0]?.toUpperCase()}${verb.slice(1)}"`);
  return out;
}

/** "Paged" in the description exactly when the tool takes a cursor, "Not paged" otherwise. */
export function lintPagingText(tool: Pick<ToolDefinition, 'description' | 'inputSchema'>): string[] {
  const paged = Object.keys((tool.inputSchema as { shape: Record<string, unknown> }).shape).includes(
    'cursor',
  );
  const says = /Paged: pass nextCursor back as cursor\./.test(tool.description);
  const not = /Not paged\./.test(tool.description);
  if (paged && !says) return ['takes cursor but does not say "Paged: pass nextCursor back as cursor."'];
  if (!paged && says) return ['says Paged but takes no cursor'];
  if (!paged && !not) return ['says neither Paged nor Not paged'];
  return [];
}

const CONTAINS = /^Only [a-z ]+ whose name contains this text\.$/;

/** Shared argument names carry the shared type and description (tools/common.ts), nothing local. */
export function lintArgumentShapes(input: Json): string[] {
  const out: string[] = [];
  const props = (input['properties'] ?? {}) as Record<string, Json>;
  const typeOf = (p: Json): string => String(p['type'] ?? '');
  const expectType = (name: string, type: string): void => {
    const p = props[name];
    if (p !== undefined && typeOf(p) !== type)
      out.push(`argument ${name}: type ${type} (found ${typeOf(p)})`);
  };
  for (const name of ['asset', 'project', 'team', 'sprint', 'member', 'time_range', 'cursor'])
    expectType(name, 'string');
  for (const name of ['assets', 'status', 'fields']) expectType(name, 'array');
  for (const name of [
    'include_closed',
    'minimal_output',
    'skip_related',
    'include_child_projects',
    'dry_run',
    'confirm',
  ])
    expectType(name, 'boolean');
  expectType('limit', 'integer');
  for (const [name, descriptions] of Object.entries(ARGUMENT_VOCABULARY)) {
    const p = props[name];
    if (p === undefined) continue;
    const d = String(p['description'] ?? '');
    if (!descriptions.some((known) => d.startsWith(known)))
      out.push(`argument ${name}: describe it as tools/common.ts does (use the shared schema)`);
  }
  const format = props['format'];
  if (format !== undefined) {
    if (JSON.stringify(format['enum']) !== '["auto","table","csv","json"]' || format['default'] !== 'auto')
      out.push('argument format: enum auto, table, csv, json with default auto');
  }
  const contains = props['contains'];
  if (contains !== undefined && !CONTAINS.test(String(contains['description'] ?? '')))
    out.push('argument contains: use containsArg("<things>")');
  for (const [name, p] of Object.entries(props)) {
    if (name.startsWith('max_') && typeOf(p) !== 'integer')
      out.push(`argument ${name}: max_<things> is an integer`);
    if (name.endsWith('_contains') && typeOf(p) !== 'string') out.push(`argument ${name}: a string`);
  }
  const sortBy = props['sort_by'];
  if (sortBy !== undefined) {
    const values = (sortBy['enum'] ?? []) as string[];
    if (!values.includes('id') || sortBy['default'] !== 'id')
      out.push('argument sort_by: an enum with id as the default (the cheap, stable order)');
  }
  return out;
}

/** Output keys the conventions name keep their meaning and type; refused spellings of them are listed. */
const OUTPUT_TYPES: Readonly<Record<string, string>> = {
  items: 'array',
  nextCursor: 'string',
  truncated: 'boolean',
  partial: 'boolean',
  notes: 'array',
  hiddenOutsideScope: 'boolean',
  total: 'integer',
  window: 'object',
  url: 'string',
  number: 'string',
  assetType: 'string',
  oid: 'string',
  name: 'string',
};
const REFUSED_OUTPUT: Readonly<Record<string, string>> = {
  hasMore: 'nextCursor, or truncated for a bounded list',
  has_more: 'nextCursor',
  next_cursor: 'nextCursor',
  cursor: 'nextCursor',
  totalCount: 'total',
  count: 'total (only when computed)',
  warnings: 'notes',
  errors: 'notes',
  isPartial: 'partial',
  incomplete: 'partial',
};

export function lintOutputShape(output: Json | undefined): string[] {
  if (output === undefined) return [];
  const out: string[] = [];
  walk(output, (node, path) => {
    const props = node['properties'];
    if (props === null || typeof props !== 'object' || Array.isArray(props)) return;
    for (const [key, schema] of Object.entries(props as Record<string, Json>)) {
      if (!/^[a-z][A-Za-z0-9]*$/.test(key)) out.push(`output ${path}.${key}: camelCase keys`);
      const replacement = REFUSED_OUTPUT[key];
      if (replacement !== undefined) out.push(`output ${path}.${key}: use ${replacement}`);
      const type = OUTPUT_TYPES[key];
      if (type !== undefined && schema['type'] !== type)
        out.push(`output ${path}.${key}: type ${type} (found ${String(schema['type'])})`);
    }
  });
  const top = (output['properties'] ?? {}) as Record<string, Json>;
  if (top['items'] !== undefined) {
    for (const key of ['partial', 'notes'])
      if (top[key] === undefined)
        out.push(`list output declares ${key} (partial and notes are the shared contract)`);
  }
  const win = top['window'];
  if (win !== undefined) {
    const wp = (win['properties'] ?? {}) as Record<string, unknown>;
    if (wp['since'] === undefined || wp['until'] === undefined) out.push('output window: { since, until }');
  }
  const notes = top['notes'];
  if (notes !== undefined && (notes['items'] as Json | undefined)?.['type'] !== 'string')
    out.push('output notes: an array of strings');
  return out;
}

/** Every violation of one tool. */
export function lintTool(tool: ToolDefinition): Violation[] {
  return [
    ...lintToolName(tool.name).map((detail) => ({ tool: tool.name, rule: 'naming', detail })),
    ...lintDescription(tool).map((detail) => ({ tool: tool.name, rule: 'description', detail })),
    ...lintSchemas(tool).map((detail) => ({ tool: tool.name, rule: 'schema', detail })),
    ...lintTitle(tool).map((detail) => ({ tool: tool.name, rule: 'title', detail })),
    ...lintPagingText(tool).map((detail) => ({ tool: tool.name, rule: 'paging', detail })),
    ...lintArgumentShapes(advertisedSchemas(tool).input).map((detail) => ({
      tool: tool.name,
      rule: 'arguments',
      detail,
    })),
    ...lintOutputShape(advertisedSchemas(tool).output).map((detail) => ({
      tool: tool.name,
      rule: 'output',
      detail,
    })),
  ];
}
