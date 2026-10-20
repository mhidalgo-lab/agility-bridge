// SPDX-License-Identifier: Apache-2.0
// P0-07 spike: one MCP server factory, filtered per (fake) workspace grant, served to both protocol eras.
// Agility-shaped tools with canned data: no Agility instance, no real tokens.
import { acceptedContent, fromJsonSchema, inputRequired, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const READ_TOOLS = ['whoami', 'query_assets', 'get_work_item'] as const;
export const WRITE_TOOLS = ['add_comment'] as const;
export type ToolName = (typeof READ_TOOLS)[number] | (typeof WRITE_TOOLS)[number];

export interface FakeGrant {
  slug: string;
  tools: ReadonlySet<ToolName>;
}

/** Workspace `team` gets reads and the write tool; workspace `viewer` gets reads only. */
export function resolveGrant(slug: string): FakeGrant | undefined {
  if (slug === 'team') return { slug, tools: new Set([...READ_TOOLS, ...WRITE_TOOLS]) };
  if (slug === 'viewer') return { slug, tools: new Set(READ_TOOLS) };
  return undefined;
}

/** Static spike bearer per workspace (not a secret; P0-07 tests static bearer headers). */
export const spikeToken = (slug: string): string => `ab_spike_${slug}`;

const ro = { readOnlyHint: true, openWorldHint: true } as const;

// JSON Schema 2020-12 with $defs/oneOf, passed through fromJsonSchema (the generic query's filter shape, simplified).
const queryInput = fromJsonSchema<{
  asset_type: string;
  filters?: Array<
    | { attribute: string; op: 'eq' | 'contains'; value: string }
    | { attribute: string; op: 'in'; values: string[] }
  >;
  limit?: number;
}>({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  $defs: {
    scalar: {
      type: 'object',
      properties: {
        attribute: { type: 'string', maxLength: 200 },
        op: { enum: ['eq', 'contains'] },
        value: { type: 'string', maxLength: 1000 },
      },
      required: ['attribute', 'op', 'value'],
      additionalProperties: false,
    },
    list: {
      type: 'object',
      properties: {
        attribute: { type: 'string', maxLength: 200 },
        op: { const: 'in' },
        values: { type: 'array', items: { type: 'string', maxLength: 1000 }, maxItems: 50 },
      },
      required: ['attribute', 'op', 'values'],
      additionalProperties: false,
    },
  },
  properties: {
    asset_type: { type: 'string', enum: ['Story', 'Defect', 'Task', 'Test', 'Epic'] },
    filters: {
      type: 'array',
      items: { oneOf: [{ $ref: '#/$defs/scalar' }, { $ref: '#/$defs/list' }] },
      maxItems: 10,
    },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
  required: ['asset_type'],
  additionalProperties: false,
});

const rowsOutput = z.object({
  rows: z.array(z.object({ number: z.string(), name: z.string(), status: z.string() })),
  total: z.number(),
  nextCursor: z.string().nullable(),
});

const ITEMS = [
  { number: 'B-01001', name: 'Synthetic story one', status: 'In Progress' },
  { number: 'B-01002', name: 'Synthetic story two', status: 'Done' },
  { number: 'D-00042', name: 'Synthetic defect', status: 'Open' },
];

export type ApprovalOutcome = 'approved' | 'declined';

export function buildServer(grant: FakeGrant, era: string): McpServer {
  const server = new McpServer({ name: 'agility-bridge-spike', version: '0.0.0' });

  if (grant.tools.has('whoami')) {
    server.registerTool(
      'whoami',
      {
        description: 'Show the connection: workspace and protocol era.',
        inputSchema: z.object({}),
        annotations: ro,
      },
      async () => ({ content: [{ type: 'text', text: `workspace=${grant.slug} era=${era}` }] }),
    );
  }
  if (grant.tools.has('query_assets')) {
    server.registerTool(
      'query_assets',
      {
        description: 'Query an allowed asset type with structured filters. Paged.',
        inputSchema: queryInput,
        outputSchema: rowsOutput,
        annotations: ro,
      },
      async ({ asset_type, limit }) => {
        const prefix = asset_type === 'Defect' ? 'D-' : 'B-';
        const rows = ITEMS.filter((r) => r.number.startsWith(prefix)).slice(0, limit ?? 100);
        const out = { rows, total: rows.length, nextCursor: null };
        return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
      },
    );
  }
  if (grant.tools.has('get_work_item')) {
    server.registerTool(
      'get_work_item',
      {
        description: 'One work item by number (B-01234, D-…).',
        inputSchema: z.object({ asset: z.string().regex(/^[A-Z]{1,3}-\d{1,8}$/) }),
        annotations: ro,
      },
      async ({ asset }) => {
        const item = ITEMS.find((r) => r.number === asset);
        if (!item) return { isError: true, content: [{ type: 'text', text: `AB_NOT_FOUND: ${asset}` }] };
        return { content: [{ type: 'text', text: JSON.stringify(item) }] };
      },
    );
  }
  if (grant.tools.has('add_comment')) {
    const confirmSchema = z.object({ approve: z.boolean() });
    server.registerTool(
      'add_comment',
      {
        description: 'Adds a comment to a work item. Changes Agility. Needs approval.',
        inputSchema: z.object({ asset: z.string(), text: z.string().max(2000) }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ asset, text }, ctx) => {
        const message = `Add this comment to ${asset}?\n\n${text}`;
        if (era === 'modern') {
          // 2026-07-28: multi round trip. The client answers the embedded elicitation and retries the call.
          const answer = acceptedContent(ctx.mcpReq.inputResponses, 'approval', confirmSchema);
          if (answer === undefined && ctx.mcpReq.inputResponses === undefined) {
            return inputRequired({
              inputRequests: { approval: inputRequired.elicit({ message, requestedSchema: confirmSchema }) },
            });
          }
          const outcome: ApprovalOutcome = answer?.approve === true ? 'approved' : 'declined';
          return result(outcome, asset, 'input_required');
        }
        // 2025 era: push-style elicitation/create, which needs a channel back to the client.
        try {
          const r = await ctx.mcpReq.elicitInput({
            message,
            requestedSchema: {
              type: 'object',
              properties: { approve: { type: 'boolean', title: 'Approve' } },
              required: ['approve'],
            },
          });
          const outcome: ApprovalOutcome =
            r.action === 'accept' && (r.content as { approve?: unknown } | undefined)?.approve === true
              ? 'approved'
              : 'declined';
          return result(outcome, asset, 'elicitation/create');
        } catch (e) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `AB_APPROVAL_UNAVAILABLE: this client cannot answer an approval prompt here (${(e as Error).message})`,
              },
            ],
          };
        }
      },
    );
  }
  return server;
}

/** The text names the approval channel so the harness can record it. */
function result(outcome: ApprovalOutcome, asset: string, channel: string) {
  return outcome === 'approved'
    ? {
        content: [
          { type: 'text' as const, text: `approved via ${channel}: comment added to ${asset} (simulated)` },
        ],
      }
    : { isError: true, content: [{ type: 'text' as const, text: `AB_APPROVAL_DECLINED via ${channel}` }] };
}
