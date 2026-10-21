// SPDX-License-Identifier: Apache-2.0
// P1-13: the lints over the whole catalogue, and every refused example of the conventions as a case.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CORE_TOOLS, defineTool, type ToolDefinition } from '../src/index.ts';
import { lintArgumentName, lintDescription, lintSchemas, lintTool, lintToolName } from './harness/lint.ts';

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
      /state the cost \(9/,
    );
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
