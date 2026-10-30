// SPDX-License-Identifier: Apache-2.0
// When MCP Apps views are offered (P8-03, T27): only to a client that declared the extension, only for a tool that links a
// view, never with the switch off, and the page a client reads is the static, policy-carrying one.

import { APPS_MIME_TYPE, buildMcpServer, defineTool, ToolRegistry } from '@agility-bridge/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeContext } from '../../core/test/helpers/context.ts';
import { ORIGIN, world } from './helpers/world.ts';

const linked = defineTool({
  name: 'linked_tool',
  title: 'Linked',
  description: 'A tool whose result has a view (test tool, no data).',
  kind: 'read',
  group: 'core',
  cost: 0,
  view: 'sprint-burndown',
  inputSchema: z.object({}),
  handler: async () => ({ text: 'ok', structured: { burndown: [] } }),
});
const plain = defineTool({
  name: 'plain_tool',
  title: 'Plain',
  description: 'A tool without a view (test tool, no data).',
  kind: 'read',
  group: 'core',
  cost: 0,
  inputSchema: z.object({}),
  handler: async () => ({ text: 'ok' }),
});

const APPS = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [APPS_MIME_TYPE] } } };

async function connect(
  apps: 'off' | 'on' | 'detect',
  capabilities: Record<string, unknown>,
  tools = [linked, plain],
) {
  const server = buildMcpServer({ tools, ctx: makeContext(), apps });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client(
    { name: 't', version: '0' },
    { capabilities: capabilities as never, versionNegotiation: { mode: 'legacy' } },
  );
  await client.connect(clientSide);
  return client;
}

const metaOf = async (client: Client, name: string) =>
  (await client.listTools()).tools.find((t) => t.name === name)?._meta as
    | { ui?: { resourceUri?: string }; 'ui/resourceUri'?: string }
    | undefined;

describe('stdio-like connection (detect)', () => {
  it('links the view and serves the page to a client that declared Apps', async () => {
    const client = await connect('detect', APPS);
    const meta = await metaOf(client, 'linked_tool');
    expect(meta?.ui?.resourceUri).toBe('ui://agility-bridge/sprint-burndown');
    expect(meta?.['ui/resourceUri']).toBe('ui://agility-bridge/sprint-burndown');
    expect(await metaOf(client, 'plain_tool')).toBeUndefined();
    const listed = (await client.listResources()).resources.filter((r) => r.uri.startsWith('ui://'));
    expect(listed.map((r) => [r.uri, r.mimeType])).toEqual([
      ['ui://agility-bridge/sprint-burndown', APPS_MIME_TYPE],
    ]);
    const read = await client.readResource({ uri: 'ui://agility-bridge/sprint-burndown' });
    const content = read.contents[0] as {
      mimeType?: string;
      text?: string;
      _meta?: { ui?: { csp?: object } };
    };
    expect(content.mimeType).toBe(APPS_MIME_TYPE);
    expect(content.text).toContain("connect-src 'none'");
    expect(content._meta?.ui?.csp).toEqual({
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    });
  });

  it.each([
    ['declares nothing', {}],
    [
      'declares the extension without the HTML profile',
      { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html'] } } },
    ],
    [
      'declares it under experimental only',
      { experimental: { 'io.modelcontextprotocol/ui': { mimeTypes: [APPS_MIME_TYPE] } } },
    ],
  ])('offers nothing to a client that %s', async (_name, caps) => {
    const client = await connect('detect', caps);
    expect(await metaOf(client, 'linked_tool')).toBeUndefined();
    expect((await client.listResources()).resources.filter((r) => r.uri.startsWith('ui://'))).toEqual([]);
    await expect(client.readResource({ uri: 'ui://agility-bridge/sprint-burndown' })).rejects.toThrow();
  });

  it('offers nothing with the switch off, whatever the client declares', async () => {
    const client = await connect('off', APPS);
    expect(await metaOf(client, 'linked_tool')).toBeUndefined();
    expect((await client.listResources()).resources.filter((r) => r.uri.startsWith('ui://'))).toEqual([]);
    await expect(client.readResource({ uri: 'ui://agility-bridge/sprint-burndown' })).rejects.toThrow();
  });

  it('offers no view when the caller holds no tool that links one', async () => {
    const client = await connect('detect', APPS, [plain]);
    expect((await client.listResources()).resources.filter((r) => r.uri.startsWith('ui://'))).toEqual([]);
    await expect(client.readResource({ uri: 'ui://agility-bridge/status-distribution' })).rejects.toThrow();
  });

  it('keeps the text result identical with and without Apps', async () => {
    const withApps = await connect('detect', APPS);
    const without = await connect('detect', {});
    const a = await withApps.callTool({ name: 'linked_tool', arguments: {} });
    const b = await without.callTool({ name: 'linked_tool', arguments: {} });
    expect(a.content).toEqual(b.content);
    expect(a.structuredContent).toEqual(b.structuredContent);
  });
});

describe('the registry', () => {
  it('refuses a tool that names a view that does not exist', () => {
    expect(() =>
      new ToolRegistry().register({ ...plain, name: 'bad_view_tool', view: 'nope' } as never),
    ).toThrow(/unknown MCP Apps view/);
    expect(() => new ToolRegistry().register(linked)).not.toThrow();
  });
});

type Mode = 'legacy' | { pin: '2026-07-28' };

/** A client of the HTTP app that declares `capabilities` and sends `authorization` (the world's device tokens). */
async function httpClient(
  w: Awaited<ReturnType<typeof world>>,
  slug: string,
  token: string,
  mode: Mode,
  capabilities: Record<string, unknown>,
) {
  const { Client: C, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/w/${slug}/mcp`), {
    fetch: (url, init) => Promise.resolve(w.app.fetch(new Request(url, init))),
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new C(
    { name: 'http-test', version: '0.0.0' },
    { capabilities: capabilities as never, versionNegotiation: { mode } },
  );
  await client.connect(transport);
  return client;
}

const sprintMeta = async (client: Client) => {
  const tool = (await client.listTools()).tools.find((t) => t.name === 'get_sprint');
  return tool?._meta as { ui?: { resourceUri?: string } } | undefined;
};
const uiResources = async (client: Client) =>
  (await client.listResources()).resources.filter((r) => r.uri.startsWith('ui://')).map((r) => r.uri);

describe('MCP Apps over HTTP (P8-03)', () => {
  const MODERN: Mode = { pin: '2026-07-28' };

  it('offers the view to a 2026-07-28 request that declared Apps, and serves the page', async () => {
    const w = await world();
    const client = await httpClient(w, 'team-a', w.tokens.alice, MODERN, APPS);
    expect((await sprintMeta(client))?.ui?.resourceUri).toBe('ui://agility-bridge/sprint-burndown');
    expect(await uiResources(client)).toEqual(['ui://agility-bridge/sprint-burndown']);
    const read = await client.readResource({ uri: 'ui://agility-bridge/sprint-burndown' });
    expect((read.contents[0] as { mimeType?: string }).mimeType).toBe(APPS_MIME_TYPE);
    expect((read.contents[0] as { text?: string }).text).toContain("default-src 'none'");
    // No request reached Agility for any of it: the page is static.
    expect(w.agilityTokens).toEqual([]);
    await client.close();
  });

  it('offers nothing to a 2026-07-28 request that declared no Apps', async () => {
    const w = await world();
    const client = await httpClient(w, 'team-a', w.tokens.alice, MODERN, {});
    expect(await sprintMeta(client)).toBeUndefined();
    expect(await uiResources(client)).toEqual([]);
    await expect(client.readResource({ uri: 'ui://agility-bridge/sprint-burndown' })).rejects.toThrow();
    await client.close();
  });

  it('never offers Apps to a 2025-era stateless request, which carries no capabilities after initialize', async () => {
    const w = await world();
    const client = await httpClient(w, 'team-a', w.tokens.alice, 'legacy', APPS);
    expect(await sprintMeta(client)).toBeUndefined();
    expect(await uiResources(client)).toEqual([]);
    await client.close();
  });

  it('offers nothing with the kill switch off, whatever the client declares', async () => {
    const w = await world({ mcpApps: false });
    const client = await httpClient(w, 'team-a', w.tokens.alice, MODERN, APPS);
    expect(await sprintMeta(client)).toBeUndefined();
    expect(await uiResources(client)).toEqual([]);
    await expect(client.readResource({ uri: 'ui://agility-bridge/sprint-burndown' })).rejects.toThrow();
    await client.close();
  });

  it('offers a view only to a caller whose grant holds a tool that links it (no get_sprint: no view)', async () => {
    const w = await world();
    const client = await httpClient(w, 'team-b', w.tokens.bob, MODERN, APPS);
    expect(await uiResources(client)).toEqual([]);
    await expect(client.readResource({ uri: 'ui://agility-bridge/sprint-burndown' })).rejects.toThrow();
    await client.close();
  });

  it('never offers a view without a valid credential', async () => {
    const w = await world();
    const res = await w.app.fetch(
      new Request(`${ORIGIN}/w/team-a/mcp`, {
        method: 'POST',
        headers: {
          host: '127.0.0.1:8787',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'resources/read',
          params: { uri: 'ui://agility-bridge/sprint-burndown' },
        }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('AB_MCP_APPS', () => {
  const defaults = { callBudget: 1000, maxResponseBytes: 8_388_608 };
  it('is on by default, off with off, refuses anything else without echoing it, and is a known setting', async () => {
    const { parseServerSettings, SERVER_SETTING_NAMES, SettingsError } = await import('../src/index.ts');
    expect(parseServerSettings({}, defaults).mcpApps).toBe(true);
    expect(parseServerSettings({ AB_MCP_APPS: 'on' }, defaults).mcpApps).toBe(true);
    expect(parseServerSettings({ AB_MCP_APPS: 'off' }, defaults).mcpApps).toBe(false);
    expect(() => parseServerSettings({ AB_MCP_APPS: 'sure-secret' }, defaults)).toThrow(SettingsError);
    try {
      parseServerSettings({ AB_MCP_APPS: 'sure-secret' }, defaults);
    } catch (e) {
      expect((e as Error).message).not.toContain('sure-secret');
    }
    expect(SERVER_SETTING_NAMES).toContain('AB_MCP_APPS');
  });
});
