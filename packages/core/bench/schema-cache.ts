// SPDX-License-Identifier: Apache-2.0
// tools/list cost with and without the per-process JSON Schema cache (P1-01, L-020). Run: pnpm --filter @agility-bridge/core bench
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { buildMcpServer, defineTool, type ToolDefinition } from '../src/index.ts';
import { makeContext } from '../test/helpers/context.ts';

// A representative input shape: a scope, filters, paging and a field list, like the Phase 1 list tools.
const input = z.object({
  project: z.string().min(1).max(200).optional().describe('Agility project name or Scope:<id>.'),
  include_children: z.boolean().default(true).describe('Include child projects.'),
  status: z.array(z.string().max(100)).max(20).optional().describe('Status names.'),
  owner: z.string().max(200).optional().describe('Member name, username or "me".'),
  sprint: z.string().max(200).optional().describe('Sprint name, "current" or Timebox:<id>.'),
  changed_since: z.string().datetime().optional().describe('ISO 8601 UTC timestamp.'),
  fields: z.array(z.string().max(100)).max(30).optional().describe('Extra attributes to return.'),
  sort: z.enum(['ID', '-ID', 'ChangeDate', '-ChangeDate', 'Order']).default('ID'),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().max(500).optional().describe('nextCursor from the previous page.'),
});
const output = z.object({
  items: z.array(
    z.object({ id: z.string(), number: z.string(), name: z.string(), status: z.string().optional() }),
  ),
  nextCursor: z.string().optional(),
});

const tools: ToolDefinition[] = Array.from({ length: 25 }, (_, i) =>
  defineTool({
    name: `bench_tool_${i}`,
    title: `Bench tool ${i}`,
    description: 'A synthetic list tool with a representative input and output schema.',
    kind: 'read',
    group: 'core',
    cost: 1,
    inputSchema: input,
    outputSchema: output,
    handler: async () => ({ text: '' }),
  }),
);

const ctx = makeContext();
const variants = {
  // What the SDK does by default: convert zod on every tools/list.
  uncached: () => {
    const s = new McpServer(
      { name: 'bench', version: '0' },
      { capabilities: { tools: { listChanged: false } } },
    );
    for (const t of tools) {
      s.registerTool(
        t.name,
        { title: t.title, description: t.description, inputSchema: t.inputSchema, outputSchema: output },
        async () => ({ content: [] }),
      );
    }
    return s;
  },
  cached: () => buildMcpServer({ tools, ctx }),
};

const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
};

console.log('| Variant | p50 ms | p95 ms | bytes |');
console.log('|---|---|---|---|');
for (const [name, build] of Object.entries(variants)) {
  const handler = createMcpHandler(build, { legacy: 'stateless', responseMode: 'json' });
  const once = async (): Promise<number> => {
    // Yield once per request, as a real server does (L-159).
    await new Promise((r) => setTimeout(r, 0));
    const res = await handler.fetch(new Request('http://bench/mcp', { method: 'POST', headers, body }));
    return (await res.text()).length;
  };
  let bytes = 0;
  for (let i = 0; i < 50; i++) bytes = await once();
  const times: number[] = [];
  for (let i = 0; i < 500; i++) {
    const t = performance.now();
    await once();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const pct = (p: number) => (times[Math.floor((times.length - 1) * p)] ?? 0).toFixed(2);
  console.log(`| ${name} (25 tools) | ${pct(0.5)} | ${pct(0.95)} | ${bytes} |`);
}
