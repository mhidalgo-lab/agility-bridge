// SPDX-License-Identifier: Apache-2.0
// Heap growth per request (L-159). Run with and without YIELD=1:
//   node --expose-gc --import tsx test/heap.ts ping 4000
//   YIELD=1 node --expose-gc --import tsx test/heap.ts ping 4000
// Without YIELD the loop never returns to the event loop, so V8 keeps every request's WeakRef targets (AbortSignal →
// transport → server) alive and the heap grows; with YIELD=1, as on a real server, it stays flat.
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

const [mode = 'no-tools', itersArg = '2000'] = process.argv.slice(2);
const handler = createMcpHandler(() => new McpServer({ name: 'leak', version: '0.0.0' }), {
  legacy: 'stateless',
  ...(mode === 'sse' ? {} : { responseMode: 'json' as const }),
});
const method = mode === 'ping' ? 'ping' : 'tools/list';
const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} });
const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
};
const iters = Number(itersArg);
for (let i = 1; i <= iters; i++) {
  if (process.env['YIELD'] === '1') await new Promise((r) => setImmediate(r));
  const r = await handler.fetch(new Request('http://x/mcp', { method: 'POST', headers, body }));
  await r.text();
  if (i % (iters / 4) === 0) {
    globalThis.gc?.();
    console.log(`${mode} after ${i}: heapUsed ${(process.memoryUsage().heapUsed / 1e6).toFixed(1)} MB`);
  }
}
