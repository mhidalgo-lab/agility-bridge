// SPDX-License-Identifier: Apache-2.0
// URL-mode elicitation for the approval page (P7-46, ADR-0013, THREAT_MODEL A13, T31): a client that declares
// `elicitation.url` on a connection that can be pushed to is asked to open the page's own link; every other client gets
// today's answer. The link, the page and its checks are unchanged: the request names no change and approves nothing.
import { buildMcpServer, ERROR_META_KEY, ErrorCode } from '@agility-bridge/core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import {
  answeringChannel,
  FakeItems,
  makeRuntime,
  makeTestWriteTool,
  TEST_TOOL,
  writeContext,
} from '../../core/test/helpers/writes.ts';

const LINK = 'https://example.test/admin/approve/abc';
const CALL = { name: TEST_TOOL, arguments: { item: 'B-00001', status: 'Done', confirm: true } };

type Declared = 'url' | 'form+url' | 'form' | 'none';
const capabilities = (d: Declared) =>
  d === 'none'
    ? {}
    : { elicitation: d === 'url' ? { url: {} } : d === 'form+url' ? { form: {}, url: {} } : { form: {} } };

const pendingPage = (link: string) =>
  answeringChannel(() => ({ status: 'pending', link, expiresAt: 1 }), 'page');

async function connect(
  fake: FakeItems,
  declared: Declared,
  reaction: 'accept' | 'decline' | 'throw',
  options: { link?: string; policy?: 'page_only'; modern?: boolean } = {},
): Promise<{ client: Client; asked: Array<Record<string, unknown>> }> {
  const runtime = makeRuntime({
    page: pendingPage(options.link ?? LINK),
    ...(options.policy === undefined ? {} : { approvalPolicy: options.policy }),
  });
  const asked: Array<Record<string, unknown>> = [];
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    {
      versionNegotiation: { mode: options.modern === true ? { pin: '2026-07-28' } : 'legacy' },
      capabilities: capabilities(declared) as never,
    },
  );
  if (declared !== 'none') {
    client.setRequestHandler('elicitation/create', async (request) => {
      asked.push(request.params as Record<string, unknown>);
      if (reaction === 'throw') throw new Error('the client cannot open links');
      return reaction === 'accept' ? { action: 'accept' } : { action: 'decline' };
    });
  }
  const tools = [makeTestWriteTool(fake)];
  if (options.modern === true) {
    const handler = createMcpHandler(() => buildMcpServer({ tools, ctx: writeContext(runtime) }), {
      legacy: 'stateless',
      responseMode: 'json',
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://test/mcp'), {
        fetch: (url, init) => handler.fetch(new Request(url, init)),
      }),
    );
  } else {
    const server = buildMcpServer({ tools, ctx: () => writeContext(runtime), listChanged: true });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
  }
  return { client, asked };
}

const text = (r: { content?: unknown }): string =>
  ((r.content as Array<{ text?: string }> | undefined) ?? []).map((c) => c.text ?? '').join('');
const codeOf = (r: { _meta?: unknown }): string | undefined =>
  ((r._meta as Record<string, unknown> | undefined)?.[ERROR_META_KEY] as { code?: string } | undefined)?.code;

describe('URL-mode elicitation for the approval page (P7-46)', () => {
  it.each(['url', 'form+url'] as const)(
    'a client that declares %s is asked to open the same link, and the answer still carries it',
    async (declared) => {
      const fake = new FakeItems();
      const { client, asked } = await connect(fake, declared, 'accept', { policy: 'page_only' });
      const result = await client.callTool(CALL);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({ mode: 'url', url: LINK });
      expect(typeof asked[0]?.['elicitationId']).toBe('string');
      // Accepting means "open the page", never approval: nothing is sent and the pending answer is unchanged.
      expect(result.isError).toBe(true);
      expect(codeOf(result)).toBe(ErrorCode.WriteApprovalPending);
      expect(text(result)).toContain(LINK);
      expect(fake.sends).toHaveLength(0);
    },
  );

  it('the request names no change, target or value, and no form', async () => {
    const fake = new FakeItems();
    const { client, asked } = await connect(fake, 'url', 'accept', { policy: 'page_only' });
    await client.callTool(CALL);
    const sent = JSON.stringify(asked[0]);
    for (const secret of ['B-00001', 'Done', 'In Progress', 'Story', 'Status', 'requestedSchema']) {
      expect(sent, secret).not.toContain(secret);
    }
    expect(String(asked[0]?.['message'])).toContain('approves nothing');
  });

  it('a client that does not declare url (form only, or nothing) gets today, unchanged answer and no request', async () => {
    for (const declared of ['form', 'none'] as const) {
      const fake = new FakeItems();
      const { client, asked } = await connect(fake, declared, 'accept', { policy: 'page_only' });
      const result = await client.callTool(CALL);
      expect(asked, declared).toHaveLength(0);
      expect(codeOf(result)).toBe(ErrorCode.WriteApprovalPending);
      expect(text(result)).toContain(LINK);
      expect(fake.sends).toHaveLength(0);
    }
  });

  it('a decline or a client that fails to handle the request changes nothing: the link is still returned', async () => {
    for (const reaction of ['decline', 'throw'] as const) {
      const fake = new FakeItems();
      const { client, asked } = await connect(fake, 'url', reaction, { policy: 'page_only' });
      const result = await client.callTool(CALL);
      expect(asked, reaction).toHaveLength(1);
      expect(codeOf(result)).toBe(ErrorCode.WriteApprovalPending);
      expect(text(result)).toContain(LINK);
      expect(fake.sends).toHaveLength(0);
    }
  });

  it('2026-07-28 requests keep the plain link (no push request there, P7-51)', async () => {
    const fake = new FakeItems();
    const { client, asked } = await connect(fake, 'url', 'accept', { policy: 'page_only', modern: true });
    const result = await client.callTool(CALL);
    expect(asked).toHaveLength(0);
    expect(codeOf(result)).toBe(ErrorCode.WriteApprovalPending);
    expect(text(result)).toContain(LINK);
  });

  it('a link that is not http(s) or carries credentials is never handed to a client to open', async () => {
    for (const link of ['javascript:alert(1)', 'https://user:pw@example.test/x', 'not a url']) {
      const fake = new FakeItems();
      const { client, asked } = await connect(fake, 'url', 'accept', { policy: 'page_only', link });
      const result = await client.callTool(CALL);
      expect(asked, link).toHaveLength(0);
      expect(codeOf(result)).toBe(ErrorCode.WriteApprovalPending);
      expect(fake.sends).toHaveLength(0);
    }
  });

  it('without page_only a form-capable client is still asked in the client first, not sent to the page', async () => {
    const fake = new FakeItems();
    const { client, asked } = await connect(fake, 'form+url', 'accept');
    const result = await client.callTool(CALL);
    // The form elicitation is the approval channel (the handler's accept carries no `approve: true`: declined).
    expect(asked).toHaveLength(1);
    expect(asked[0]?.['mode'] ?? 'form').not.toBe('url');
    expect(codeOf(result)).toBe(ErrorCode.WriteApprovalDeclined);
    expect(fake.sends).toHaveLength(0);
  });
});
