// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AbError,
  buildMcpServer,
  createBudget,
  defineTool,
  ErrorCode,
  Secret,
  type ToolCallEvent,
  type ToolDefinition,
} from '../src/index.ts';
import { makeContext } from './helpers/context.ts';
import { rpc } from './helpers/mcp.ts';

const whoami = defineTool({
  name: 'whoami_test',
  title: 'Who am I',
  description: 'Show which credential and request this call runs with (test tool).',
  kind: 'read',
  group: 'core',
  cost: 0,
  inputSchema: z.object({ delay_ms: z.number().int().min(0).max(200).default(0) }),
  outputSchema: z.object({ credential: z.string(), requestId: z.string() }),
  handler: async ({ delay_ms }, ctx) => {
    await new Promise((r) => setTimeout(r, delay_ms));
    ctx.budget.spend(1);
    const out = { credential: ctx.credential.id, requestId: ctx.requestId };
    return { text: JSON.stringify(out), structured: out };
  },
});

const failing = (error: unknown): ToolDefinition =>
  defineTool({
    name: 'failing_test',
    title: 'Failing',
    description: 'Always fails, to test the error mapping of the server.',
    kind: 'read',
    group: 'core',
    cost: 0,
    inputSchema: z.object({}),
    handler: async () => {
      throw error;
    },
  });

describe('buildMcpServer', () => {
  it('lists only the given tools with derived annotations and no listChanged promise', async () => {
    const ctx = makeContext();
    const init = await rpc(() => buildMcpServer({ tools: [whoami], ctx }), 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    });
    expect((init['capabilities'] as { tools?: unknown }).tools).toEqual({ listChanged: false });
    const list = await rpc(() => buildMcpServer({ tools: [whoami], ctx }), 'tools/list');
    const tools = list['tools'] as Array<{
      name: string;
      annotations: Record<string, unknown>;
      inputSchema: Record<string, unknown>;
    }>;
    expect(tools.map((t) => t.name)).toEqual(['whoami_test']);
    expect(tools[0]?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(tools[0]?.inputSchema['$schema']).toBeUndefined();
  });

  it('maps a thrown AbError to an error result and an unknown error to AB_INTERNAL with the request id', async () => {
    const events: ToolCallEvent[] = [];
    const ctx = makeContext({ requestId: 'req-x' });
    const r1 = await rpc(
      () =>
        buildMcpServer({
          tools: [failing(new AbError(ErrorCode.NotFound, 'Missing.'))],
          ctx,
          onToolCall: (e) => events.push(e),
        }),
      'tools/call',
      { name: 'failing_test', arguments: {} },
    );
    expect(r1['isError']).toBe(true);
    expect(JSON.stringify(r1['content'])).toContain('AB_NOT_FOUND: Missing.');
    const r2 = await rpc(
      () => buildMcpServer({ tools: [failing(new Error('stack with internals'))], ctx }),
      'tools/call',
      {
        name: 'failing_test',
        arguments: {},
      },
    );
    expect(JSON.stringify(r2['content'])).toContain('AB_INTERNAL: Internal error. Reference: req-x.');
    expect(JSON.stringify(r2)).not.toContain('stack with internals');
    expect(events).toEqual([
      expect.objectContaining({ tool: 'failing_test', status: 'error', errorCode: 'AB_NOT_FOUND' }),
    ]);
  });

  it('keeps two parallel requests with different credentials apart (no bleed, T21)', async () => {
    const call = (cred: string, delay: number) => {
      const ctx = makeContext({
        requestId: `req-${cred}`,
        credential: { id: cred, kind: 'personal', token: new Secret(`FAKE-${cred}`) },
        budget: createBudget(5),
      });
      return rpc(() => buildMcpServer({ tools: [whoami], ctx }), 'tools/call', {
        name: 'whoami_test',
        arguments: { delay_ms: delay },
      });
    };
    const results = await Promise.all([call('alice', 60), call('bob', 0), call('alice', 0), call('bob', 60)]);
    expect(results.map((r) => r['structuredContent'])).toEqual([
      { credential: 'alice', requestId: 'req-alice' },
      { credential: 'bob', requestId: 'req-bob' },
      { credential: 'alice', requestId: 'req-alice' },
      { credential: 'bob', requestId: 'req-bob' },
    ]);
  });

  it('gives every stdio call a fresh context through a factory', async () => {
    let n = 0;
    const factory = () => makeContext({ requestId: `call-${++n}`, budget: createBudget(1) });
    const build = () => buildMcpServer({ tools: [whoami], ctx: factory });
    const a = await rpc(build, 'tools/call', { name: 'whoami_test', arguments: {} });
    const b = await rpc(build, 'tools/call', { name: 'whoami_test', arguments: {} });
    expect([a['structuredContent'], b['structuredContent']]).toEqual([
      expect.objectContaining({ requestId: 'call-1' }),
      expect.objectContaining({ requestId: 'call-2' }),
    ]);
  });

  it('refuses input that fails the schema before the handler runs', async () => {
    const r = await rpc(() => buildMcpServer({ tools: [whoami], ctx: makeContext() }), 'tools/call', {
      name: 'whoami_test',
      arguments: { delay_ms: 5000 },
    });
    expect(r['isError']).toBe(true);
  });
});

describe('budget', () => {
  it('reports used and remaining and throws AB_BUDGET_EXHAUSTED when spent', () => {
    const b = createBudget(2);
    b.spend();
    expect([b.used, b.remaining, b.canSpend(2)]).toEqual([1, 1, false]);
    b.spend();
    expect(() => b.spend(1, 'the next page')).toThrow(/budget ran out before the next page/);
  });
});
