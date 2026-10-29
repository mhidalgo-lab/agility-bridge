// SPDX-License-Identifier: Apache-2.0
// The write pipeline behind the real MCP server and the SDK client, both protocol eras (P7-01, P0-07): elicitation over
// 2026-07-28 `input_required`, push elicitation on a stateful 2025-era connection, no channel on stateless 2025-era
// HTTP, and a client without the capability answered with our own tool error (never a protocol error).

import {
  buildMcpServer,
  defineTool,
  ERROR_META_KEY,
  ErrorCode,
  type ToolDefinition,
} from '@agility-bridge/core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  answeringChannel,
  FakeItems,
  makeRuntime,
  makeTestWriteTool,
  TEST_TOOL,
  writeContext,
} from '../../core/test/helpers/writes.ts';

type Mode = 'legacy' | { pin: '2026-07-28' };

/** Stands in for `whoami`: reports the approval channel the request context carries. */
const PROBE = defineTool({
  name: 'whoami',
  title: 'Probe',
  description: 'Reports the write approval channel of this request.',
  kind: 'read',
  group: 'core',
  cost: 0,
  inputSchema: z.object({}),
  handler: async (_input, ctx) => ({ text: 'ok', structured: { workspace: ctx.workspace } }),
});

function tools(fake: FakeItems): ToolDefinition[] {
  return [PROBE, makeTestWriteTool(fake)];
}

async function httpClient(
  fake: FakeItems,
  runtime: ReturnType<typeof makeRuntime>,
  mode: Mode,
  elicitation: 'accept' | 'decline' | 'none',
): Promise<{ client: Client; questions: string[] }> {
  const handler = createMcpHandler(() => buildMcpServer({ tools: tools(fake), ctx: writeContext(runtime) }), {
    legacy: 'stateless',
    responseMode: 'json',
  });
  const transport = new StreamableHTTPClientTransport(new URL('http://test/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  return connected(transport, mode, elicitation);
}

async function connected(
  transport: Parameters<Client['connect']>[0],
  mode: Mode,
  elicitation: 'accept' | 'decline' | 'none',
): Promise<{ client: Client; questions: string[] }> {
  const questions: string[] = [];
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    {
      versionNegotiation: { mode },
      capabilities: elicitation === 'none' ? {} : { elicitation: { form: {} } },
    },
  );
  if (elicitation !== 'none') {
    client.setRequestHandler('elicitation/create', async (request) => {
      questions.push(String((request.params as { message?: string }).message));
      return elicitation === 'accept'
        ? { action: 'accept', content: { approve: true } }
        : { action: 'decline' };
    });
  }
  await client.connect(transport);
  return { client, questions };
}

const text = (r: { content?: unknown }): string =>
  ((r.content as Array<{ text?: string }> | undefined) ?? []).map((c) => c.text ?? '').join('');
const codeOf = (r: { _meta?: unknown }): string | undefined =>
  ((r._meta as Record<string, unknown> | undefined)?.[ERROR_META_KEY] as { code?: string } | undefined)?.code;

const CALL = { name: TEST_TOOL, arguments: { item: 'B-00001', status: 'Done', confirm: true } };

describe('write tools over MCP', () => {
  it('lists the write tool with write annotations and the added dry_run and confirm arguments', async () => {
    const fake = new FakeItems();
    const { client } = await httpClient(fake, makeRuntime(), { pin: '2026-07-28' }, 'accept');
    const listed = (await client.listTools()).tools.find((t) => t.name === TEST_TOOL);
    expect(listed?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(Object.keys(listed?.inputSchema.properties ?? {})).toEqual([
      'item',
      'status',
      'dry_run',
      'confirm',
    ]);
    expect(listed?.description).toContain('Changes Agility. Needs approval.');
  });

  it('2026-07-28 with elicitation: the person sees the whole change, approves, and it is applied once', async () => {
    const fake = new FakeItems();
    const runtime = makeRuntime();
    const { client, questions } = await httpClient(fake, runtime, { pin: '2026-07-28' }, 'accept');
    const result = await client.callTool(CALL);
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain('Applied');
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('"In Progress"');
    expect(questions[0]).toContain('"Done"');
    expect(fake.sends).toHaveLength(1);
    expect(runtime.audit.records.map((r) => r.phase)).toEqual(['intent', 'outcome']);
  });

  it('2026-07-28 declined: AB_WRITE_APPROVAL_DECLINED as a tool error, nothing sent', async () => {
    const fake = new FakeItems();
    const { client } = await httpClient(fake, makeRuntime(), { pin: '2026-07-28' }, 'decline');
    const result = await client.callTool(CALL);
    expect(result.isError).toBe(true);
    expect(codeOf(result)).toBe(ErrorCode.WriteApprovalDeclined);
    expect(fake.sends).toHaveLength(0);
  });

  it('2026-07-28 without the elicitation capability: our AB_WRITE_APPROVAL_UNAVAILABLE tool error, not a protocol error', async () => {
    const fake = new FakeItems();
    const { client } = await httpClient(fake, makeRuntime(), { pin: '2026-07-28' }, 'none');
    const result = await client.callTool(CALL);
    expect(result.isError).toBe(true);
    expect(codeOf(result)).toBe(ErrorCode.WriteApprovalUnavailable);
    expect(fake.sends).toHaveLength(0);
  });

  it('2025-era stateless HTTP cannot be elicited even when the client declares it (P0-07)', async () => {
    const fake = new FakeItems();
    const { client, questions } = await httpClient(fake, makeRuntime(), 'legacy', 'accept');
    const result = await client.callTool(CALL);
    expect(result.isError).toBe(true);
    expect(codeOf(result)).toBe(ErrorCode.WriteApprovalUnavailable);
    expect(questions).toHaveLength(0);
    expect(fake.sends).toHaveLength(0);
  });

  it('2025-era stateful connection (stdio): push elicitation approves, and declining is an error', async () => {
    for (const answer of ['accept', 'decline'] as const) {
      const fake = new FakeItems();
      const server = buildMcpServer({
        tools: tools(fake),
        ctx: () => writeContext(makeRuntime()),
        listChanged: true,
      });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const { client, questions } = await connected(clientSide, 'legacy', answer);
      const result = await client.callTool(CALL);
      expect(questions).toHaveLength(1);
      if (answer === 'accept') {
        expect(result.isError).not.toBe(true);
        expect(fake.sends).toHaveLength(1);
      } else {
        expect(codeOf(result)).toBe(ErrorCode.WriteApprovalDeclined);
        expect(fake.sends).toHaveLength(0);
      }
    }
  });

  it('whoami reports the approval channel of this request, per era and capability', async () => {
    const cases: Array<[Mode, 'accept' | 'none', string]> = [
      [{ pin: '2026-07-28' }, 'accept', 'elicitation'],
      [{ pin: '2026-07-28' }, 'none', 'unavailable'],
      ['legacy', 'accept', 'unavailable'],
    ];
    for (const [mode, elicitation, expected] of cases) {
      const { client } = await httpClient(new FakeItems(), makeRuntime(), mode, elicitation);
      const r = await client.callTool({ name: 'whoami', arguments: {} });
      expect(
        (r.structuredContent as { workspace: { writes: { approval: string } } }).workspace.writes.approval,
      ).toBe(expected);
    }
  });

  it('approval off reports not_required; the out-of-band channel is used when the request cannot be elicited', async () => {
    const off = await httpClient(new FakeItems(), makeRuntime({ approval: 'off' }), 'legacy', 'none');
    const r1 = await off.client.callTool({ name: 'whoami', arguments: {} });
    expect(
      (r1.structuredContent as { workspace: { writes: { approval: string } } }).workspace.writes.approval,
    ).toBe('not_required');
    const page = await httpClient(
      new FakeItems(),
      makeRuntime({ page: answeringChannel(true, 'page') }),
      'legacy',
      'none',
    );
    const r2 = await page.client.callTool({ name: 'whoami', arguments: {} });
    expect(
      (r2.structuredContent as { workspace: { writes: { approval: string } } }).workspace.writes.approval,
    ).toBe('page');
  });

  it('a server built without the write tool does not list or run it', async () => {
    const fake = new FakeItems();
    const handler = createMcpHandler(
      () => buildMcpServer({ tools: [PROBE], ctx: writeContext(makeRuntime()) }),
      { legacy: 'stateless', responseMode: 'json' },
    );
    const transport = new StreamableHTTPClientTransport(new URL('http://test/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    const { client } = await connected(transport, { pin: '2026-07-28' }, 'accept');
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain(TEST_TOOL);
    const r = await client.callTool(CALL).catch((e: unknown) => e);
    expect(r instanceof Error || (r as { isError?: boolean }).isError === true).toBe(true);
    expect(fake.sends).toHaveLength(0);
  });
});

describe('the approval policy page_only (P7-26): a client that can elicit is never asked', () => {
  const pending = () =>
    answeringChannel(
      () => ({ status: 'pending', link: 'https://example.test/admin/approve/x', expiresAt: 1 }),
      'page',
    );
  const pageOnly = (withPage: boolean) =>
    makeRuntime({ approvalPolicy: 'page_only', ...(withPage ? { page: pending() } : {}) });
  const channelOf = async (client: Client) =>
    (
      (await client.callTool({ name: 'whoami', arguments: {} })).structuredContent as {
        workspace: { writes: { approval: string } };
      }
    ).workspace.writes.approval;

  it('2026-07-28 with an accepting client: the link, no question, nothing sent', async () => {
    const fake = new FakeItems();
    const { client, questions } = await httpClient(fake, pageOnly(true), { pin: '2026-07-28' }, 'accept');
    const result = await client.callTool(CALL);
    expect(result.isError).toBe(true);
    expect(codeOf(result)).toBe(ErrorCode.WriteApprovalPending);
    expect(text(result)).toContain('https://example.test/admin/approve/x');
    expect(questions).toHaveLength(0);
    expect(fake.sends).toHaveLength(0);
    expect(await channelOf(client)).toBe('page');
  });

  it('a 2025-era connection that keeps its capabilities (push elicitation) is not asked either', async () => {
    const fake = new FakeItems();
    const server = buildMcpServer({
      tools: tools(fake),
      ctx: () => writeContext(pageOnly(true)),
      listChanged: true,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const { client, questions } = await connected(clientSide, 'legacy', 'accept');
    const result = await client.callTool(CALL);
    expect(codeOf(result)).toBe(ErrorCode.WriteApprovalPending);
    expect(questions).toHaveLength(0);
    expect(fake.sends).toHaveLength(0);
  });

  it('without a page the answer is unavailable (its own hint), and the client is still not asked', async () => {
    const fake = new FakeItems();
    const { client, questions } = await httpClient(fake, pageOnly(false), { pin: '2026-07-28' }, 'accept');
    const result = await client.callTool(CALL);
    expect(codeOf(result)).toBe(ErrorCode.WriteApprovalUnavailable);
    expect(text(result)).toContain('approval page');
    expect(questions).toHaveLength(0);
    expect(fake.sends).toHaveLength(0);
    expect(await channelOf(client)).toBe('unavailable');
  });

  it('the policy any (and an absent one) still asks in the client first', async () => {
    for (const approvalPolicy of ['any', undefined] as const) {
      const fake = new FakeItems();
      const runtime = makeRuntime({
        page: pending(),
        ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
      });
      const { client, questions } = await httpClient(fake, runtime, { pin: '2026-07-28' }, 'accept');
      expect((await client.callTool(CALL)).isError).not.toBe(true);
      expect(questions).toHaveLength(1);
      expect(fake.sends).toHaveLength(1);
    }
  });
});
