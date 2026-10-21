// SPDX-License-Identifier: Apache-2.0
// End-to-end (P1-11): the CLI as a child process, driven by the MCP client SDK over stdio, against the synthetic
// fixture upstream behind a local HTTP server. Also checks that stdout carries only MCP frames (L-021).
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import snapshot from '../../../packages/core/test/fixtures/agility/meta-snapshot.json' with { type: 'json' };
import { FakeAgility } from '../../../packages/core/test/harness/index.ts';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const TOKEN = 'FAKE-e2e-token-0123456789';

const fake = new FakeAgility({
  meta: snapshot as unknown as Record<string, unknown>,
  baseUrl: 'http://127.0.0.1/SyntheticInstance',
  assets: {
    Member: [{ _oid: 'Member:20', Name: 'Ann Example', Username: 'ann', IsSelf: true, AssetState: 64 }],
    Scope: [{ _oid: 'Scope:1001', Name: 'Mobile App', AssetState: 64, ChildrenMeAndDown: ['Scope:1001'] }],
    Story: [
      {
        _oid: 'Story:1001',
        AssetType: 'Story',
        Number: 'B-01001',
        Name: 'Sign-in page',
        AssetState: 64,
        Scope: 'Scope:1001',
        'Scope.Name': 'Mobile App',
      },
    ],
  },
});

let server: Server;
let baseUrl = '';
let tokensSeen = new Set<string>();

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    tokensSeen.add(String(req.headers.authorization));
    const body = Buffer.concat(chunks);
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method ?? 'GET',
      headers: req.headers as Record<string, string>,
      ...(req.method === 'POST' ? { body } : {}),
    });
    try {
      const answer = await fake.fetch(request);
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      res.end(Buffer.from(await answer.arrayBuffer()));
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/SyntheticInstance`;
});

afterAll(() => server?.close());

// Only what a child Node process needs to start (Windows needs SystemRoot and friends); no AB_ variables leak in.
const PASS = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
];
const childEnv = (extra: Record<string, string>) => ({
  ...Object.fromEntries(
    PASS.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k] as string]])),
  ),
  ...extra,
});

async function connect(env: Record<string, string>, mode: 'legacy' | { pin: '2026-07-28' } = 'legacy') {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--conditions=source', ENTRY],
    env: childEnv(env),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'e2e', version: '0.0.0' }, { versionNegotiation: { mode } });
  await client.connect(transport);
  return client;
}

const text = (r: { content?: unknown }) =>
  ((r.content as Array<{ text?: string }> | undefined) ?? []).map((c) => c.text ?? '').join('');

describe('stdio end to end', () => {
  it.each(['legacy', { pin: '2026-07-28' }] as const)(
    'lists the tools and answers calls (%o)',
    async (mode) => {
      tokensSeen = new Set();
      const client = await connect(
        { AB_AGILITY_URL: baseUrl, AB_AGILITY_TOKEN: TOKEN, AB_PROJECTS: 'Scope:1001' },
        mode,
      );
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(['whoami', 'query_assets', 'search_work_items', 'list_members']),
      );
      const who = await client.callTool({ name: 'whoami', arguments: {} });
      expect(who.isError).toBeFalsy();
      expect(who.structuredContent).toMatchObject({
        member: { oid: 'Member:20' },
        projects: { allowed: ['Scope:1001'] },
      });
      const stories = await client.callTool({
        name: 'query_assets',
        arguments: { asset_type: 'Story', fields: ['Name'] },
      });
      expect(text(stories)).toContain('B-01001');
      expect([...tokensSeen]).toEqual([`Bearer ${TOKEN}`]);
      await client.close();
    },
    60_000,
  );

  it('removes the generic tools with AB_GENERIC_QUERY=off and honours AB_TOOLS', async () => {
    const client = await connect({
      AB_AGILITY_URL: baseUrl,
      AB_AGILITY_TOKEN: TOKEN,
      AB_GENERIC_QUERY: 'off',
      AB_TOOLS: 'whoami,query_assets',
    });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['whoami']);
    await client.close();
  }, 60_000);

  it('lists the tools unconfigured and answers every call with setup guidance', async () => {
    const client = await connect({});
    expect((await client.listTools()).tools.length).toBeGreaterThan(5);
    const r = await client.callTool({ name: 'whoami', arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(
      /^AB_AUTH_UNAUTHORIZED: agility-bridge is not configured yet\.\nHint: Set AB_AGILITY_URL/,
    );
    await client.close();
  }, 60_000);

  it('writes only MCP frames to stdout, and the token never appears in any output', async () => {
    const child = spawn(process.execPath, ['--conditions=source', ENTRY], {
      env: childEnv({ AB_AGILITY_URL: baseUrl, AB_AGILITY_TOKEN: TOKEN, AB_LOG_LEVEL: 'debug' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: {} } });
    const deadline = Date.now() + 30_000;
    while ((stdout.match(/"id":3/g) ?? []).length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    child.stdin.end();
    await new Promise((r) => child.on('close', r));
    const lines = stdout.split('\n').filter((l) => l !== '');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    expect(stderr).toContain('"level":"info"');
    expect(stdout + stderr).not.toContain(TOKEN);
  }, 60_000);
});
