// SPDX-License-Identifier: Apache-2.0
// P0-07 (L-020): cost of building the MCP server per request and answering tools/list, with 25 and 40 tools.
//   zod-fresh:   zod schemas built per request (worst case)
//   zod-shared:  zod schemas built once, server built per request (the SDK converts them on every tools/list)
//   json-cached: JSON Schemas converted once (z.toJSONSchema) and registered through fromJsonSchema per request
// Usage: tsx test/bench.ts
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

type Variant = 'zod-fresh' | 'zod-shared' | 'json-cached';

function zodSchemaFor(i: number) {
  return z.object({
    project: z.string().max(200).describe('Agility project OID token or exact name'),
    team: z.string().max(200).optional(),
    status: z
      .array(z.enum(['Future', 'In Progress', 'Done', 'Accepted']))
      .max(10)
      .optional(),
    contains: z.string().max(500).optional(),
    filters: z
      .array(
        z.discriminatedUnion('op', [
          z.object({ attribute: z.string().max(200), op: z.literal('eq'), value: z.string().max(1000) }),
          z.object({
            attribute: z.string().max(200),
            op: z.literal('in'),
            values: z.array(z.string()).max(50),
          }),
        ]),
      )
      .max(10)
      .optional(),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().max(500).optional(),
    [`field_${i}`]: z.boolean().optional(),
  });
}

const output = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  total: z.number(),
  nextCursor: z.string().nullable(),
});

function definitions(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    name: `tool_${String(i).padStart(2, '0')}`,
    description: `List or search assets of kind ${i} within the workspace's Agility projects. Paged: pass nextCursor back as cursor.`,
  }));
}

function makeFactory(n: number, variant: Variant) {
  const defs = definitions(n);
  const sharedZod = defs.map((_, i) => zodSchemaFor(i));
  const cachedJson = sharedZod.map((s) => z.toJSONSchema(s));
  const cachedOut = z.toJSONSchema(output);
  return () => {
    const server = new McpServer({ name: 'bench', version: '0.0.0' });
    defs.forEach((d, i) => {
      const inputSchema =
        variant === 'zod-fresh'
          ? zodSchemaFor(i)
          : variant === 'zod-shared'
            ? sharedZod[i]
            : fromJsonSchema(cachedJson[i] as Record<string, unknown>);
      const outputSchema =
        variant === 'json-cached' ? fromJsonSchema(cachedOut as Record<string, unknown>) : output;
      server.registerTool(
        d.name,
        {
          description: d.description,
          inputSchema,
          outputSchema,
          annotations: { readOnlyHint: true },
        } as never,
        async () => ({
          content: [{ type: 'text', text: '' }],
          structuredContent: { rows: [], total: 0, nextCursor: null },
        }),
      );
    });
    return server;
  };
}

const LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
};

async function run(n: number, variant: Variant, iterations: number) {
  const handler = createMcpHandler(makeFactory(n, variant), { legacy: 'stateless', responseMode: 'json' });
  const once = async (): Promise<number> => {
    // One event-loop turn per request, as on a real server: a tight await loop never ends the job, so V8 keeps every
    // request's WeakRef targets (AbortSignal → server) alive and the heap grows until it runs out (L-159).
    await new Promise((r) => setImmediate(r));
    const res = await handler.fetch(
      new Request('http://bench/mcp', { method: 'POST', headers: HEADERS, body: LIST }),
    );
    return (await res.text()).length;
  };
  const size = await once();
  for (let i = 0; i < 50; i++) await once();
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t = performance.now();
    await once();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const pct = (p: number): string => (times[Math.floor((times.length - 1) * p)] ?? 0).toFixed(2);
  return { n, variant, p50: pct(0.5), p95: pct(0.95), bytes: size };
}

console.log(
  `Node ${process.version}, ${process.arch}; 500 tools/list requests per row after 50 warm-up requests`,
);
console.log('| Tools | Variant | p50 ms | p95 ms | tools/list bytes |');
console.log('|---|---|---|---|---|');
for (const n of [25, 40]) {
  for (const variant of ['zod-fresh', 'zod-shared', 'json-cached'] as const) {
    const r = await run(n, variant, 500);
    console.log(`| ${r.n} | ${r.variant} | ${r.p50} | ${r.p95} | ${r.bytes} |`);
  }
}
