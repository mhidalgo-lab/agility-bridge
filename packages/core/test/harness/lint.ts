// SPDX-License-Identifier: Apache-2.0
// The tool lints (tool conventions, "Lints"; P1-13): naming, descriptions, schemas. Pure functions over a tool and its
// advertised JSON Schemas, so each refused example of the conventions is a test case.
import { type ToolDefinition, withCachedJsonSchema } from '../../src/index.ts';

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
  if (tool.cost >= 8 && !new RegExp(`\\b${tool.cost} Agility requests\\b`).test(d))
    out.push(`state the cost (${tool.cost} Agility requests)`);
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

/** Every violation of one tool. */
export function lintTool(tool: ToolDefinition): Violation[] {
  return [
    ...lintToolName(tool.name).map((detail) => ({ tool: tool.name, rule: 'naming', detail })),
    ...lintDescription(tool).map((detail) => ({ tool: tool.name, rule: 'description', detail })),
    ...lintSchemas(tool).map((detail) => ({ tool: tool.name, rule: 'schema', detail })),
  ];
}
