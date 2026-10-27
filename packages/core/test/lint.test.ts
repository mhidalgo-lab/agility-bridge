// SPDX-License-Identifier: Apache-2.0
// P1-13: the lints over the whole catalogue, and every refused example of the conventions as a case.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CORE_TOOLS, defineTool, type ToolDefinition } from '../src/index.ts';
import {
  lintArgumentName,
  lintArgumentShapes,
  lintDescription,
  lintOutputShape,
  lintPagingText,
  lintSchemas,
  lintTitle,
  lintTool,
  lintToolName,
} from './harness/lint.ts';

describe('the catalogue passes every lint', () => {
  it.each(CORE_TOOLS.map((t) => [t.name, t] as const))('%s', (_name, tool) => {
    expect(lintTool(tool)).toEqual([]);
  });
});

describe('naming lint refuses', () => {
  it.each([
    'getWorkItem',
    'GetWorkItem',
    'work_item_get',
    'stories',
    'fetch_story',
    'read_defects',
    'do_query',
    'query_assets_v2',
    'get_work_item_new',
  ])('tool name %s', (name) => expect(lintToolName(name)).not.toEqual([]));

  it.each([
    'id',
    'oid',
    'number',
    'scope',
    'iteration',
    'timebox',
    'owner',
    'assignee',
    'page',
    'page_size',
    'pageSize',
    'next_cursor',
    'max_results',
    'since',
    'until',
    'window',
    'where',
    'filter_expression',
    'query',
    'oql',
    'raw',
    'start_h',
    'effort_d',
  ])('argument %s', (name) => expect(lintArgumentName(name)).not.toEqual([]));

  it.each([
    'asset',
    'project',
    'sprint',
    'member',
    'limit',
    'cursor',
    'time_range',
    'as_of',
    'filters',
    'any_of',
    'effort_hours',
    'request_timeout_ms',
  ])('accepts %s', (name) => {
    expect(lintArgumentName(name)).toEqual([]);
  });
});

describe('description lint refuses', () => {
  const tool = (description: string, extra: Partial<ToolDefinition> = {}) => ({
    description,
    kind: 'read' as const,
    cost: 1,
    ...extra,
  });
  it.each([
    ['This tool lists defects. Not paged.', /start with the action/],
    ['Use this to list defects. Not paged.', /start with the action/],
    ['A tool that lists defects. Not paged.', /start with the action/],
    [`List defects. Not paged. ${'x'.repeat(450)}`, /at most 450/],
    ['List defects.', /paged/],
    ['List defects (default 25 rows). Not paged.', /typed default/],
    ['List defects; the default is `open`. Not paged.', /typed default/],
    ['List defects with Custom_Severity. Not paged.', /instance-specific/],
  ])('%j', (description, rule) => {
    expect(lintDescription(tool(description)).join('; ')).toMatch(rule);
  });

  it('a write tool without the side-effect sentence and a costly tool without its cost', () => {
    expect(lintDescription(tool('Add a comment. Not paged.', { kind: 'write' })).join(';')).toMatch(
      /Changes Agility/,
    );
    expect(lintDescription(tool('List everything. Not paged.', { cost: 9 })).join(';')).toMatch(
      /Cold call: up to 9 Agility requests/,
    );
    expect(
      lintDescription(
        tool('List everything. Not paged. A cold call can make up to 9 Agility requests.', { cost: 9 }),
      ).join(';'),
    ).toMatch(/Cold call: up to 9 Agility requests/);
    expect(
      lintDescription(tool('List everything. Not paged. Cold call: up to 9 Agility requests.', { cost: 9 })),
    ).toEqual([]);
    expect(
      lintDescription(
        tool('List one thing. Not paged. Cold call: up to 3 Agility requests.', { cost: 3 }),
      ).join(';'),
    ).toMatch(/only when it reaches 8/);
  });

  it.each([
    'What changed on an asset. Not paged.',
    'Lists defects. Not paged.',
    'The defects of a sprint. Not paged.',
  ])('a description that does not start with an imperative verb: %j', (description) => {
    expect(lintDescription(tool(description)).join(';')).toMatch(/imperative verb/);
  });
});

describe('title lint refuses', () => {
  it.each([
    ['list_teams', 'Teams', /starts with "List"/],
    ['get_team', 'Get A Team', /sentence case/],
    ['get_team', 'get a team', /capital/],
    ['get_team', 'Get a team.', /punctuation/],
    ['get_team', 'Get a team with its workflow, sprint and members and more', /at most 40/],
  ])('%s: %j', (name, title, rule) => {
    expect(lintTitle({ name, title }).join(';')).toMatch(rule);
  });
  it('accepts sentence case with proper names and noun tools', () => {
    expect(lintTitle({ name: 'list_projects', title: 'List Agility projects' })).toEqual([]);
    expect(lintTitle({ name: 'sprint_health', title: 'Sprint health' })).toEqual([]);
  });
});

describe('paging text lint refuses', () => {
  const withCursor = z.object({ cursor: z.string().optional() });
  const without = z.object({});
  it('says Paged exactly when there is a cursor', () => {
    expect(lintPagingText({ description: 'List x. Not paged.', inputSchema: withCursor })).not.toEqual([]);
    expect(
      lintPagingText({ description: 'List x. Paged: pass nextCursor back as cursor.', inputSchema: without }),
    ).not.toEqual([]);
    expect(lintPagingText({ description: 'List x.', inputSchema: without })).not.toEqual([]);
    expect(
      lintPagingText({
        description: 'List x. Paged: pass nextCursor back as cursor.',
        inputSchema: withCursor,
      }),
    ).toEqual([]);
  });
});

describe('argument shape lint refuses', () => {
  const props = (p: Record<string, unknown>) => ({ properties: p });
  it.each([
    [{ team: { type: 'string', description: 'The team.' } }, /argument team: describe it as/],
    [
      {
        project: { type: 'array', description: 'Agility project: name or Scope:<id>, within the workspace.' },
      },
      /type string/,
    ],
    [{ limit: { type: 'number' } }, /type integer/],
    [{ include_closed: { type: 'string' } }, /type boolean/],
    [
      {
        format: {
          type: 'string',
          enum: ['auto', 'json'],
          default: 'auto',
          description: 'auto (a table up to 8 columns, else CSV), table, csv or json.',
        },
      },
      /argument format/,
    ],
    [{ contains: { type: 'string', description: 'Substring.' } }, /containsArg/],
    [{ max_rows: { type: 'string' } }, /max_<things> is an integer/],
    [{ sort_by: { enum: ['name', 'id'], default: 'name' } }, /sort_by/],
  ])('%j', (p, rule) => {
    expect(lintArgumentShapes(props(p)).join(';')).toMatch(rule);
  });
});

describe('output shape lint refuses', () => {
  const list = { type: 'object', properties: { items: { type: 'array' } } };
  it.each([
    [{ type: 'object', properties: { hasMore: { type: 'boolean' } } }, /use nextCursor/],
    [{ type: 'object', properties: { next_cursor: { type: 'string' } } }, /use nextCursor/],
    [{ type: 'object', properties: { partial: { type: 'string' } } }, /type boolean/],
    [{ type: 'object', properties: { truncated: { type: 'string' } } }, /type boolean/],
    [{ type: 'object', properties: { items: { type: 'number' } } }, /type array/],
    [
      {
        type: 'object',
        properties: { nested: { type: 'object', properties: { item_count: { type: 'number' } } } },
      },
      /camelCase/,
    ],
    [
      {
        type: 'object',
        properties: { window: { type: 'object', properties: { from: { type: 'string' } } } },
      },
      /window/,
    ],
    [list, /declares partial/],
  ])('%j', (schema, rule) => {
    expect(lintOutputShape(schema).join(';')).toMatch(rule);
  });
});

describe('schema lint refuses', () => {
  const base = {
    name: 'list_things',
    title: 'T',
    description: 'List things. Paged: pass nextCursor back as cursor.',
    kind: 'read' as const,
    group: 'core',
    cost: 1,
    handler: async () => ({ text: '' }),
  };
  it('nullable and type arrays, closed outputs, a limit without maximum, a cursor without nextCursor', () => {
    const bad = defineTool({
      ...base,
      inputSchema: z.object({
        limit: z.number().int(),
        cursor: z.string().optional(),
        name: z.string().nullable(),
      }),
      outputSchema: z.object({ items: z.array(z.object({ a: z.string() })) }),
    } as ToolDefinition);
    const v = lintSchemas(bad).join('\n');
    expect(v).toMatch(/type array|nullable|anyOf/);
    expect(v).toMatch(/limit has no maximum/);
    expect(v).toMatch(/no nextCursor/);
  });

  it('filters without the no-comma rule and typed defaults in argument descriptions', () => {
    const bad = defineTool({
      ...base,
      inputSchema: z.object({
        filters: z.array(z.object({ field: z.string() })).optional(),
        limit: z.number().max(5).optional().describe('Rows (default 25).'),
      }),
    } as ToolDefinition);
    const v = lintSchemas(bad).join('\n');
    expect(v).toMatch(/no-comma rule/);
    expect(v).toMatch(/typed default/);
  });
});
