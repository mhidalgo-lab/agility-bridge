// SPDX-License-Identifier: Apache-2.0
// The public read-only tool catalogue (P8-11, THREAT_MODEL T33): off by default; when on, five discovery messages
// without a credential, the same answer for every workspace name, no storage read, no write or opt-in tool, and
// everything else still 401.
import { CORE_TOOLS, PUBLIC_CATALOG_GROUPS } from '@agility-bridge/core';
import type { Storage } from '@agility-bridge/storage';
import { describe, expect, it } from 'vitest';
import { parseServerSettings, SERVER_SETTING_NAMES, SettingsError, settingWarnings } from '../src/index.ts';
import { type Era, ORIGIN, post, type World, world } from './helpers/world.ts';

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'registry', version: '1' } },
};
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
const PING = { jsonrpc: '2.0', id: 3, method: 'ping' };
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

/** Storage that fails the test on any use: the public catalogue reads nothing. */
function untouchable(): { storage: Storage; touched: string[] } {
  const touched: string[] = [];
  const storage = new Proxy({} as Storage, {
    get(_t, prop) {
      touched.push(String(prop));
      throw new Error(`storage.${String(prop)} was read by the public catalogue`);
    },
  });
  return { storage, touched };
}

const on = { publicToolCatalog: true } as const;
const text = (res: Response) => res.text();

describe('AB_PUBLIC_TOOL_CATALOG off (the default)', () => {
  it('answers 401 to initialize, ping and tools/list without a credential', async () => {
    const w = await world();
    for (const body of [INIT, PING, LIST, INITIALIZED]) {
      const res = await post(w, 'team-a', null, body);
      expect(res.status).toBe(401);
    }
  });
});

describe('AB_PUBLIC_TOOL_CATALOG on', () => {
  it('answers the discovery messages without a credential', async () => {
    const w = await world(on);
    const init = await post(w, 'team-a', null, INIT);
    expect(init.status).toBe(200);
    expect(await text(init)).toContain('"serverInfo"');
    expect((await post(w, 'team-a', null, PING)).status).toBe(200);
    expect((await post(w, 'team-a', null, INITIALIZED)).status).toBe(202);
    const list = await post(w, 'team-a', null, LIST);
    expect(list.status).toBe(200);
    expect(await text(list)).toContain('"whoami"');
  });

  it('answers the same for a real, an unknown, a disabled and a malformed workspace, and reads no storage', async () => {
    const reference = await world();
    const ws = await reference.storage.workspaces.getBySlug('team-b');
    await reference.storage.workspaces.update((ws as { id: string }).id, { disabledAt: reference.now.t });
    const slugs = ['team-a', 'team-b', 'does-not-exist', 'A', 'x'.repeat(200)];
    const lists = new Set<string>();
    const inits = new Set<string>();
    const pings = new Set<string>();
    for (const slug of slugs) {
      const { storage, touched } = untouchable();
      const w = await world({ ...on, storage });
      const [l, i, p] = await Promise.all([
        post(w, slug, null, LIST),
        post(w, slug, null, INIT),
        post(w, slug, null, PING),
      ]);
      expect([l.status, i.status, p.status], slug).toEqual([200, 200, 200]);
      lists.add(await text(l));
      inits.add(await text(i));
      pings.add(await text(p));
      expect(touched, slug).toEqual([]);
    }
    expect(lists.size).toBe(1);
    expect(inits.size).toBe(1);
    expect(pings.size).toBe(1);
  });

  it('lists only read-only tools of the default groups: no write, report, attachment or workspace text', async () => {
    const w = await world(on);
    const res = await post(w, 'team-a', null, LIST);
    const raw = await text(res);
    const data = JSON.parse(
      raw.startsWith('{') ? raw : (raw.split('\n').find((l) => l.startsWith('data: ')) ?? '').slice(6),
    );
    const tools = data.result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
    const expected = CORE_TOOLS.filter((t) => t.kind === 'read' && PUBLIC_CATALOG_GROUPS.includes(t.group))
      .map((t) => t.name)
      .sort();
    expect(tools.map((t) => t.name).sort()).toEqual(expected);
    expect(tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
    const names = new Set(tools.map((t) => t.name));
    for (const t of CORE_TOOLS) {
      if (t.kind !== 'read' || ['attachments', 'reports', 'writes'].includes(t.group))
        expect(names.has(t.name), t.name).toBe(false);
    }
    expect(raw).not.toContain('Team A');
    expect(raw).not.toContain('team-a');
    expect(raw).not.toContain('Fake');
  });

  it.each([
    [
      'tools/call',
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
    ],
    ['prompts/list', { jsonrpc: '2.0', id: 5, method: 'prompts/list' }],
    ['resources/list', { jsonrpc: '2.0', id: 6, method: 'resources/list' }],
    ['resources/read', { jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'x://y' } }],
    ['completion/complete', { jsonrpc: '2.0', id: 8, method: 'completion/complete', params: {} }],
    ['tasks/get', { jsonrpc: '2.0', id: 9, method: 'tasks/get', params: {} }],
    ['logging/setLevel', { jsonrpc: '2.0', id: 10, method: 'logging/setLevel', params: { level: 'info' } }],
    ['an unknown method', { jsonrpc: '2.0', id: 11, method: 'x/y' }],
    ['a response', { jsonrpc: '2.0', id: 12, result: {} }],
    ['another notification', { jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }],
  ])('still answers 401 to %s without a credential', async (_name, body) => {
    const w = await world(on);
    const res = await post(w, 'team-a', null, body);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(w.agilityTokens).toEqual([]);
  });

  it('never falls back for a request that presents a credential, valid or not', async () => {
    const w = await world(on);
    for (const [slug, token] of [
      ['team-a', 'ab_live_not-a-token'],
      ['team-b', w.tokens.alice],
      ['nope', w.tokens.alice],
    ] as const) {
      expect((await post(w, slug, token, LIST)).status, slug).toBe(401);
    }
    // A malformed Authorization header and an Agility token header are credentials too.
    expect((await post(w, 'team-a', null, LIST, { authorization: 'Basic Zm9vOmJhcg==' })).status).toBe(401);
    expect((await post(w, 'team-a', null, LIST, { 'x-agility-token': '1.NotRealAgilityToken' })).status).toBe(
      401,
    );
    // A real token still gets the workspace's own tools, not the catalogue.
    expect((await post(w, 'team-b', w.tokens.bob, LIST)).status).toBe(200);
  });

  it('answers 401 to a GET, a batch, a body that is too large and a body that is not JSON', async () => {
    const w = await world(on);
    const get = await w.app.fetch(
      new Request(`${ORIGIN}/w/team-a/mcp`, { headers: { host: '127.0.0.1:8787' } }),
    );
    expect(get.status).toBe(401);
    expect((await post(w, 'team-a', null, [INIT, LIST])).status).toBe(401);
    expect((await post(w, 'team-a', null, `${JSON.stringify(LIST)}${' '.repeat(20_000)}`)).status).toBe(401);
    expect((await post(w, 'team-a', null, 'not json')).status).toBe(401);
  });

  it('is limited per address like any request, charges no authentication failure and writes no audit row', async () => {
    const calls: string[] = [];
    const w = await world({
      ...on,
      limits: {
        beforeAuth: (ip) => {
          calls.push(`before:${ip}`);
          return { ok: true };
        },
        onAuthFailure: () => {
          calls.push('failure');
        },
      },
    });
    expect((await post(w, 'team-a', null, LIST)).status).toBe(200);
    expect(calls).toEqual(['before:unknown']);
    const limited = await world({
      ...on,
      limits: { beforeAuth: () => ({ ok: false, retryAfterSeconds: 7 }) },
    });
    const res = await post(limited, 'team-a', null, LIST);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    await w.audit.flush();
    expect(await w.storage.audit.query({ limit: 1_000 })).toEqual([]);
  });

  it('refuses a call to a catalogue tool even if one reached the server (second lock)', async () => {
    const { publicCatalogTools } = await import('@agility-bridge/core');
    const tools = publicCatalogTools(CORE_TOOLS);
    expect(tools.length).toBeGreaterThan(10);
    const w: World = await world(on);
    for (const t of tools.slice(0, 3)) {
      await expect(t.handler({} as never, {} as never)).rejects.toMatchObject({
        code: 'AB_AUTH_UNAUTHORIZED',
      });
    }
    expect(w.agilityTokens).toEqual([]);
  });
});

describe('both protocol eras', () => {
  it.each<Era>(['legacy', { pin: '2026-07-28' }])(
    'lists the catalogue with no credential (%o)',
    async (era) => {
      const w = await world(on);
      const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
      const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/w/anything/mcp`), {
        fetch: (url, init) => Promise.resolve(w.app.fetch(new Request(url, init))),
      });
      const client = new Client(
        { name: 'registry', version: '0.0.0' },
        { versionNegotiation: { mode: era } },
      );
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('whoami');
      expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
      await expect(client.callTool({ name: 'whoami', arguments: {} })).rejects.toThrow();
      expect(w.agilityTokens).toEqual([]);
      expect(w.toolCalls).toEqual([]);
      await client.close();
    },
  );
});

describe('the setting', () => {
  const defaults = { callBudget: 1000, maxResponseBytes: 8_388_608 };
  it('is off by default, accepts on and off, refuses anything else without echoing it, and warns when on', () => {
    expect(parseServerSettings({}, defaults).publicToolCatalog).toBe(false);
    expect(parseServerSettings({ AB_PUBLIC_TOOL_CATALOG: 'off' }, defaults).publicToolCatalog).toBe(false);
    const enabled = parseServerSettings({ AB_PUBLIC_TOOL_CATALOG: 'on' }, defaults);
    expect(enabled.publicToolCatalog).toBe(true);
    expect(settingWarnings({}, enabled).join('\n')).toContain('AB_PUBLIC_TOOL_CATALOG');
    expect(settingWarnings({}, parseServerSettings({}, defaults)).join('\n')).not.toContain(
      'AB_PUBLIC_TOOL_CATALOG',
    );
    expect(() => parseServerSettings({ AB_PUBLIC_TOOL_CATALOG: 'sure-secret' }, defaults)).toThrow(
      SettingsError,
    );
    try {
      parseServerSettings({ AB_PUBLIC_TOOL_CATALOG: 'sure-secret' }, defaults);
    } catch (e) {
      expect((e as Error).message).not.toContain('sure-secret');
    }
    expect(SERVER_SETTING_NAMES).toContain('AB_PUBLIC_TOOL_CATALOG');
  });
});
