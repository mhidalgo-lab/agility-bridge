// SPDX-License-Identifier: Apache-2.0
// Self-monitoring of the stdio server on a real pipe (P8-20, THREAT_MODEL T30): the CLI as a child process, driven by the
// MCP client SDK in both protocol eras, with `AB_OTEL_ENDPOINT` at a loopback fake collector. A collector that is down must
// not change a single frame on stdout.
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import snapshot from '../../../packages/core/test/fixtures/agility/meta-snapshot.json' with { type: 'json' };
import { FakeAgility } from '../../../packages/core/test/harness/index.ts';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const TOKEN = 'FAKE-otel-token-0123456789';
const SECRET_HEADER = ['collector', 'key', '0123456789'].join('-');
const SECRET_TITLE = 'Sign-in page for the secret launch';

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
        Name: SECRET_TITLE,
        AssetState: 64,
        Scope: 'Scope:1001',
        'Scope.Name': 'Mobile App',
      },
    ],
  },
});

let agility: Server;
let agilityUrl = '';
let collector: Server | undefined;
const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];

beforeAll(async () => {
  agility = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method ?? 'GET',
      headers: req.headers as Record<string, string>,
      ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
    });
    try {
      const answer = await fake.fetch(request);
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      res.end(Buffer.from(await answer.arrayBuffer()));
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((r) => agility.listen(0, '127.0.0.1', r));
  agilityUrl = `http://127.0.0.1:${(agility.address() as AddressInfo).port}/SyntheticInstance`;
});
afterAll(() => agility?.close());
afterEach(async () => {
  await new Promise<void>((r) => (collector === undefined ? r() : collector.close(() => r())));
  collector = undefined;
  received.length = 0;
});

async function startCollector(): Promise<string> {
  collector = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((r) => (collector as Server).listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${((collector as Server).address() as AddressInfo).port}`;
}

const PASS = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'];
const childEnv = (extra: Record<string, string>) => ({
  ...Object.fromEntries(
    PASS.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k] as string]])),
  ),
  AB_AGILITY_URL: agilityUrl,
  AB_AGILITY_TOKEN: TOKEN,
  AB_PROJECTS: 'Scope:1001',
  ...extra,
});

interface Span {
  name: string;
  status: { code?: number };
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
}
const spansOf = (): Span[] =>
  received.flatMap((r) =>
    (
      JSON.parse(r.body) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Span[] }> }> }
    ).resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)),
  );
const attr = (s: Span, key: string) => {
  const v = s.attributes.find((a) => a.key === key)?.value;
  return v?.stringValue ?? (v?.intValue === undefined ? undefined : Number(v.intValue));
};

const ALLOWED = new Set([
  'mcp.method.name',
  'agility_bridge.method_class',
  'gen_ai.tool.name',
  'http.response.status_code',
  'agility_bridge.outcome',
  'agility_bridge.fault',
  'error.type',
  'agility_bridge.refusal',
  'agility_bridge.requests',
  'agility_bridge.request_id',
]);

async function waitFor(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}

describe('stdio self-monitoring (P8-20)', () => {
  it.each(['legacy', { pin: '2026-07-28' }] as const)(
    'sends one allowlisted span per method to the collector (%o)',
    async (mode) => {
      const url = await startCollector();
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--conditions=source', ENTRY],
        env: childEnv({ AB_OTEL_ENDPOINT: url, AB_OTEL_HEADERS: `x-api-key=${SECRET_HEADER}` }),
        stderr: 'pipe',
      });
      const client = new Client({ name: 'e2e', version: '0.0.0' }, { versionNegotiation: { mode } });
      await client.connect(transport);
      await client.listTools();
      await client.callTool({ name: 'whoami', arguments: {} });
      await client.callTool({
        name: 'query_assets',
        arguments: { asset_type: 'Story', fields: ['Name'], limit: 1 },
      });
      // The failed call: a tool the server does not have.
      await client.callTool({ name: 'no_such_tool', arguments: { title: SECRET_TITLE } }).catch(() => {});
      await client.close();
      await waitFor(() => spansOf().some((s) => s.name === 'tools/call query_assets'));

      const spans = spansOf();
      expect(received[0]?.headers['x-api-key']).toBe(SECRET_HEADER);
      expect(spans.map((s) => s.name)).toEqual(
        expect.arrayContaining(['tools/list', 'tools/call whoami', 'tools/call query_assets']),
      );
      const who = spans.find((s) => s.name === 'tools/call whoami') as Span;
      expect(attr(who, 'agility_bridge.outcome')).toBe('ok');
      expect(attr(who, 'agility_bridge.method_class')).toBe('tool_call');
      for (const s of spans) {
        for (const a of s.attributes) expect(ALLOWED.has(a.key), `${s.name}: ${a.key}`).toBe(true);
      }
      const everything = received.map((r) => r.body).join('');
      for (const secret of [TOKEN, SECRET_TITLE, SECRET_HEADER, 'Mobile App', 'Scope:1001', agilityUrl]) {
        expect(everything).not.toContain(secret);
      }
    },
    90_000,
  );

  it('a collector that is down changes nothing on stdout and never delays a call', async () => {
    const child = spawn(process.execPath, ['--conditions=source', ENTRY], {
      // Port 1 on loopback: nothing listens, the connection is refused at once.
      env: childEnv({ AB_OTEL_ENDPOINT: 'http://127.0.0.1:1', AB_LOG_LEVEL: 'debug' }),
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
    await waitFor(() => (stdout.match(/"id":2/g) ?? []).length > 0, 30_000);
    child.stdin.end();
    await new Promise((r) => child.on('close', r));
    const lines = stdout.split('\n').filter((l) => l !== '');
    expect(lines.length).toBe(2);
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    expect(lines.join('')).toContain('Member:20');
    expect(stderr).toContain('AB_OTEL_ENDPOINT is set');
    expect(stderr).toContain('telemetry export failed');
    expect(stdout + stderr).not.toContain(TOKEN);
    // The failure line names the class of the error, not the endpoint (the start-up line names the host, like `serve`).
    const failure = stderr.split('\n').find((l) => l.includes('telemetry export failed')) ?? '';
    expect(failure).not.toContain('127.0.0.1');
  }, 60_000);

  it('refuses to start on a bad endpoint or headers, naming the variable and not the value', async () => {
    for (const [env, name] of [
      [{ AB_OTEL_ENDPOINT: 'http://collector.example.com' }, 'AB_OTEL_ENDPOINT'],
      [
        { AB_OTEL_ENDPOINT: 'https://collector.example.com', AB_OTEL_HEADERS: 'no-equals-sign' },
        'AB_OTEL_HEADERS',
      ],
      [{ AB_OTEL_HEADERS: 'x-api-key=abc' }, 'AB_OTEL_HEADERS'],
    ] as const) {
      const child = spawn(process.execPath, ['--conditions=source', ENTRY], {
        env: childEnv(env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d) => {
        stderr += String(d);
      });
      const code = await new Promise((r) => child.on('close', r));
      expect(code).toBe(1);
      expect(stderr).toContain(name);
      expect(stderr).not.toContain('no-equals-sign');
      expect(stderr).not.toContain('collector.example.com');
    }
  }, 60_000);
});
