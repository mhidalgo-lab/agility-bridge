// SPDX-License-Identifier: Apache-2.0
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';

/** Sends one 2025-era JSON-RPC request through a stateless handler, as an HTTP host would, and returns `result`. */
export async function rpc(
  build: () => McpServer,
  method: string,
  params: unknown = {},
): Promise<Record<string, unknown>> {
  const handler = createMcpHandler(build, { legacy: 'stateless', responseMode: 'json' });
  const res = await handler.fetch(
    new Request('http://test/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  // The 2025-era stateless path answers over SSE; `responseMode` only shapes 2026-07-28 exchanges.
  const raw = await res.text();
  const json = raw.startsWith('{')
    ? raw
    : (raw
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .pop() ?? '{}');
  const body = JSON.parse(json) as { result?: Record<string, unknown>; error?: unknown };
  if (body.error !== undefined) throw new Error(`JSON-RPC error: ${JSON.stringify(body.error)}`);
  return body.result ?? {};
}
