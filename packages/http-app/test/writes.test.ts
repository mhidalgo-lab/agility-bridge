// SPDX-License-Identifier: Apache-2.0
// Write tools behind the HTTP host (P7-01): offered only when the server switch and every access layer enable them, the
// approval ledger in `kv`, the intent and the outcome in durable audit rows, and a failed intent write stops the write.
import { generateMasterKey, Keyring } from '@agility-bridge/auth';
import { CORE_TOOLS, ERROR_META_KEY, ErrorCode } from '@agility-bridge/core';
import type { Storage } from '@agility-bridge/storage';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { FakeItems, makeTestWriteTool, TEST_TOOL } from '../../core/test/helpers/writes.ts';
import { createHttpWrites, type HttpWrites } from '../src/index.ts';
import { ORIGIN, TOOL_INFO, type World, world } from './helpers/world.ts';

const READ_NAMES = CORE_TOOLS.filter((t) => t.kind === 'read').map((t) => t.name);
const CALL = { name: TEST_TOOL, arguments: { item: 'B-00001', status: 'Done', confirm: true } };

interface Setup {
  w: World;
  fake: FakeItems;
}

async function setup(
  opts: { switch?: boolean; auditStorage?: (s: Storage) => Storage } = {},
): Promise<Setup> {
  const fake = new FakeItems();
  const tool = makeTestWriteTool(fake);
  const toolInfo = new Map([...TOOL_INFO, [TEST_TOOL, { kind: tool.kind, group: tool.group }]]);
  let writes: HttpWrites | undefined;
  const on = opts.switch !== false;
  const w = await world(
    {
      tools: [...CORE_TOOLS, tool],
      access: {
        tools: toolInfo,
        writesEnabled: on,
        environment: 'live',
        limits: {
          defaults: { ...(await defaults()), callBudget: 1_000, genericQuery: true },
          ceilings: {},
        },
      },
      ...(on ? { writes: { runtimeFor: (a) => (writes as HttpWrites).runtimeFor(a) } } : {}),
    },
    { tools: toolInfo, ...(opts.auditStorage === undefined ? {} : { auditStorage: opts.auditStorage }) },
  );
  writes = createHttpWrites({
    storage: w.storage,
    audit: w.audit,
    keyring: await Keyring.create(generateMasterKey(1)),
    clock: { now: () => w.now.t },
  });
  // Alice's grant in team-a names the write tool explicitly in both lists; the workspace enables writes.
  await w.storage.workspaces.update(w.ids.workspaceA, {
    enabledTools: [...READ_NAMES, TEST_TOOL],
    writePolicy: { enabled: true },
  });
  await w.storage.grants.update(w.ids.aliceGrant, { tools: ['whoami', TEST_TOOL] });
  return { w, fake };
}

async function defaults() {
  const { DEFAULT_LIMITS } = await import('@agility-bridge/core');
  return { ...DEFAULT_LIMITS, maxResponseBytes: 8 * 1024 * 1024 };
}

async function client(
  w: World,
  token: string,
  elicitation = true,
): Promise<{ client: Client; asked: string[] }> {
  const asked: string[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/w/team-a/mcp`), {
    fetch: (url, init) => Promise.resolve(w.app.fetch(new Request(url, init))),
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const c = new Client(
    { name: 'http-test', version: '0.0.0' },
    {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
      capabilities: elicitation ? { elicitation: { form: {} } } : {},
    },
  );
  if (elicitation) {
    c.setRequestHandler('elicitation/create', async (r) => {
      asked.push(String((r.params as { message?: string }).message));
      return { action: 'accept', content: { approve: true } };
    });
  }
  await c.connect(transport);
  return { client: c, asked };
}

const listed = async (c: Client): Promise<string[]> => (await c.listTools()).tools.map((t) => t.name);
const codeOf = (r: { _meta?: unknown }): string | undefined =>
  ((r._meta as Record<string, unknown> | undefined)?.[ERROR_META_KEY] as { code?: string } | undefined)?.code;

describe('write tools over HTTP', () => {
  it('are offered and applied when every layer enables them: ledger in kv, intent then outcome in audit', async () => {
    const { w, fake } = await setup();
    const { client: c, asked } = await client(w, w.tokens.alice);
    expect(await listed(c)).toContain(TEST_TOOL);
    const result = await c.callTool(CALL);
    expect(result.isError).not.toBe(true);
    expect(fake.sends).toEqual([{ oid: 'Story:1', status: 'Done' }]);
    expect(asked).toHaveLength(1);
    await w.audit.flush();
    const rows = (await w.storage.audit.query({ kind: 'write' })).sort((a, b) => a.ts - b.ts);
    expect(rows.map((r) => (r.details as { phase?: string } | null)?.phase).sort()).toEqual([
      'intent',
      'outcome',
    ]);
    const intent = rows.find((r) => (r.details as { phase?: string } | null)?.phase === 'intent');
    expect(intent).toMatchObject({
      action: TEST_TOOL,
      kind: 'write',
      userId: w.ids.alice,
      grantId: w.ids.aliceGrant,
      workspaceId: w.ids.workspaceA,
      targetType: 'Story',
      targetId: 'Story:1',
      assetNumbers: ['B-00001'],
    });
    expect((intent?.details as { fields?: string[] } | undefined)?.fields).toEqual(['Status']);
    // Never a value, a token or the approval state in an audit row.
    const dump = JSON.stringify(rows);
    expect(dump).not.toMatch(/In Progress|Done|AliceAgility/);
    // The single-use round entry was taken from kv by the retried call.
    expect(await w.storage.kv.list('wr:')).toEqual([]);
  });

  it('is not offered, and refused if called, when the server switch is off', async () => {
    const { w, fake } = await setup({ switch: false });
    const { client: c } = await client(w, w.tokens.alice);
    expect(await listed(c)).not.toContain(TEST_TOOL);
    const r = await c.callTool(CALL).catch((e: unknown) => e);
    expect(r instanceof Error || (r as { isError?: boolean }).isError === true).toBe(true);
    expect(fake.sends).toHaveLength(0);
  });

  it.each([
    [
      'the workspace does not enable writes',
      (w: World) => w.storage.workspaces.update(w.ids.workspaceA, { writePolicy: { enabled: false } }),
    ],
    [
      'the workspace tool list does not name the tool',
      (w: World) => w.storage.workspaces.update(w.ids.workspaceA, { enabledTools: READ_NAMES }),
    ],
    [
      'the grant tool list does not name the tool',
      (w: World) => w.storage.grants.update(w.ids.aliceGrant, { tools: ['whoami'] }),
    ],
    [
      'the grant lists every tool ("all tools" never includes writes)',
      (w: World) => w.storage.grants.update(w.ids.aliceGrant, { tools: null }),
    ],
  ])('is absent when %s', async (_name, change) => {
    const { w, fake } = await setup();
    await change(w);
    const { client: c } = await client(w, w.tokens.alice);
    expect(await listed(c)).not.toContain(TEST_TOOL);
    const r = await c.callTool(CALL).catch((e: unknown) => e);
    expect(r instanceof Error || (r as { isError?: boolean }).isError === true).toBe(true);
    expect(fake.sends).toHaveLength(0);
    expect(await w.storage.audit.query({ kind: 'write' })).toHaveLength(0);
  });

  it('is absent for a grant that does not name it (another user, other workspace policy)', async () => {
    const { w, fake } = await setup();
    // Bob's grant is in team-b, whose workspace never enabled writes.
    const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/w/team-b/mcp`), {
      fetch: (url, init) => Promise.resolve(w.app.fetch(new Request(url, init))),
      requestInit: { headers: { authorization: `Bearer ${w.tokens.bob}` } },
    });
    const c = new Client(
      { name: 't', version: '0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await c.connect(transport);
    expect(await listed(c)).not.toContain(TEST_TOOL);
    expect(fake.sends).toHaveLength(0);
  });

  it('refuses a write whose intent cannot be stored: the audit is down, nothing is sent', async () => {
    const { w, fake } = await setup({
      auditStorage: (s) => ({
        ...s,
        audit: {
          ...s.audit,
          append: async (e) => {
            if (e.kind === 'write') throw new Error('storage is down');
            return s.audit.append(e);
          },
        },
      }),
    });
    const { client: c } = await client(w, w.tokens.alice);
    const result = await c.callTool(CALL);
    expect(result.isError).toBe(true);
    expect(codeOf(result)).toBe(ErrorCode.WriteAuditUnavailable);
    expect(fake.sends).toHaveLength(0);
    expect(fake.items.get('Story:1')?.status).toBe('In Progress');
  });

  it('refuses without a client that can approve', async () => {
    const { w, fake } = await setup();
    const { client: c } = await client(w, w.tokens.alice, false);
    const result = await c.callTool(CALL);
    expect(codeOf(result)).toBe(ErrorCode.WriteApprovalUnavailable);
    expect(fake.sends).toHaveLength(0);
    expect(await w.storage.audit.query({ kind: 'write' })).toHaveLength(0);
  });
});
