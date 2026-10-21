// SPDX-License-Identifier: Apache-2.0
// What an MCP POST carries, checked before the SDK sees it: a capped body (L-084), no JSON-RPC batch (L-014), and the
// method classified from the body (L-015) for audit and rate limits.

/** How a request counts for audit and limits. `listen` streams and notifications are never tool calls. */
export type McpMethodClass =
  | 'tool_call'
  | 'list'
  | 'read'
  | 'lifecycle'
  | 'notification'
  | 'listen'
  | 'task'
  | 'response'
  | 'other';

export interface ClassifiedRequest {
  /** The JSON-RPC method, bounded to 100 characters; `null` for a response or an unreadable message. */
  readonly method: string | null;
  readonly kind: McpMethodClass;
  /** `tools/call`: the tool name (bounded), for audit and per-tool limits. */
  readonly tool: string | null;
}

const LIST = new Set(['tools/list', 'prompts/list', 'resources/list', 'resources/templates/list']);
const READ = new Set(['prompts/get', 'resources/read', 'completion/complete']);
const LIFECYCLE = new Set(['initialize', 'server/discover', 'ping', 'logging/setLevel']);

const bounded = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;

/** Classifies one JSON-RPC message by its body (never by the `Mcp-Method` header, which a legacy request can forge). */
export function classifyMcpMessage(message: unknown): ClassifiedRequest {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return { method: null, kind: 'other', tool: null };
  }
  const m = message as Record<string, unknown>;
  const method = bounded(m['method'], 100);
  if (method === null) {
    return { method: null, kind: 'result' in m || 'error' in m ? 'response' : 'other', tool: null };
  }
  if (method === 'tools/call') {
    const params = m['params'] as Record<string, unknown> | undefined;
    return { method, kind: 'tool_call', tool: bounded(params?.['name'], 64) };
  }
  if (method === 'subscriptions/listen') return { method, kind: 'listen', tool: null };
  if (method.startsWith('notifications/')) return { method, kind: 'notification', tool: null };
  if (method.startsWith('tasks/')) return { method, kind: 'task', tool: null };
  if (LIST.has(method)) return { method, kind: 'list', tool: null };
  if (READ.has(method)) return { method, kind: 'read', tool: null };
  if (LIFECYCLE.has(method)) return { method, kind: 'lifecycle', tool: null };
  return { method, kind: 'other', tool: null };
}

export type BodyResult =
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer>; readonly message: unknown }
  | { readonly ok: false; readonly status: 400 | 413 | 415; readonly code: number; readonly message: string };

/**
 * Reads a JSON request body up to `maxBytes` (declared length checked first, the stream cancelled at the cap), parses
 * it and refuses batches.
 */
export async function readMcpBody(request: Request, maxBytes: number): Promise<BodyResult> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\s*(?:;|$)/i.test(type)) {
    return { ok: false, status: 415, code: -32600, message: 'Send MCP messages as application/json.' };
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await request.body?.cancel().catch(() => {});
    return {
      ok: false,
      status: 413,
      code: -32600,
      message: `The request body is larger than ${maxBytes} bytes.`,
    };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return {
          ok: false,
          status: 413,
          code: -32600,
          message: `The request body is larger than ${maxBytes} bytes.`,
        };
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  let message: unknown;
  try {
    message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, status: 400, code: -32700, message: 'The request body is not valid JSON.' };
  }
  if (Array.isArray(message)) {
    return {
      ok: false,
      status: 400,
      code: -32600,
      message: 'JSON-RPC batches are not supported; send one message per request.',
    };
  }
  return { ok: true, bytes, message };
}

/** A JSON-RPC error response body. */
export function jsonRpcError(code: number, message: string, id: unknown = null): string {
  const safeId = typeof id === 'string' || typeof id === 'number' ? id : null;
  return JSON.stringify({ jsonrpc: '2.0', id: safeId, error: { code, message } });
}
