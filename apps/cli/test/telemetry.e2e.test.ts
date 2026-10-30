// SPDX-License-Identifier: Apache-2.0
// Self-monitoring on a real socket (P8-07, THREAT_MODEL T30): `agility-bridge serve` with `AB_OTEL_ENDPOINT` pointing at a
// local fake collector (a real loopback HTTP server, no external service), a synthetic Agility, and one workspace whose
// Agility is unreachable. What the collector received is what the error-rate semantics are checked against.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accessServices, generateMasterKey, Keyring } from '@agility-bridge/auth';
import { CORE_TOOLS } from '@agility-bridge/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureAgility, startFixtureAgility } from '../../../scripts/fixture-agility.ts';
import { type RunningServer, startServe } from '../src/serve.ts';

const KEY = generateMasterKey(1);
let dir: string;
let agility: FixtureAgility;
let running: RunningServer | undefined;
let collectorServer: Server | undefined;
const received: Array<{
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> = [];

beforeAll(async () => {
  agility = await startFixtureAgility();
});
afterAll(() => agility.close());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ab-otel-'));
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'master.key'), KEY, { mode: 0o600 });
  received.length = 0;
});
afterEach(async () => {
  await running?.close();
  running = undefined;
  await new Promise<void>((r) => (collectorServer === undefined ? r() : collectorServer.close(() => r())));
  collectorServer = undefined;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // Windows may keep the database locked a moment longer (L-104).
  }
});

async function startCollector(): Promise<string> {
  collectorServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((r) => (collectorServer as Server).listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${((collectorServer as Server).address() as AddressInfo).port}`;
}

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

describe('agility-bridge serve with AB_OTEL_ENDPOINT', () => {
  it('exports one span per request, counts only server and upstream faults, and leaks nothing', async () => {
    const endpoint = await startCollector();
    const lines: string[] = [];
    running = await startServe(
      {
        AB_DATA_DIR: join(dir, 'data'),
        AB_MASTER_KEY_FILE: join(dir, 'master.key'),
        AB_PORT: '0',
        AB_ALLOW_HTTP_INSTANCES: 'on',
        AB_OTEL_ENDPOINT: endpoint,
        AB_OTEL_HEADERS: 'x-api-key=COLLECTOR-SECRET',
      },
      { sink: (l) => lines.push(l) },
    );
    expect(lines.join('\n')).toContain('AB_OTEL_ENDPOINT is set');
    expect(lines.join('\n')).not.toContain('COLLECTOR-SECRET');

    const svc = accessServices({
      storage: running.storage,
      keyring: await Keyring.create(KEY),
      tools: new Map(CORE_TOOLS.map((t) => [t.name, { kind: t.kind, group: t.group }])),
    });
    const user = await svc.users.create({ email: 'ann@example.test', role: 'member' });
    const seed = async (slug: string, baseUrl: string) => {
      const inst = await svc.instances.create({ label: slug, baseUrl });
      const cred = await svc.credentials.create({
        instanceId: inst.id,
        ownerUserId: user.id,
        label: slug,
        token: '1.NotARealTokenAbCdEfGh',
      });
      await (running as RunningServer).storage.credentials.update(cred.id, { validationStatus: 'valid' });
      const ws = await svc.workspaces.create({
        slug,
        name: `Secret workspace ${slug}`,
        instanceId: inst.id,
        allowedScopeIds: ['Scope:1'],
      });
      const grant = await svc.grants.create({ workspaceId: ws.id, userId: user.id, credentialId: cred.id });
      return (await svc.tokens.issue({ grantId: grant.record.id, label: 'laptop' })).token;
    };
    const upToken = await seed('up', agility.url);
    const downToken = await seed('down', 'http://127.0.0.1:1/Nowhere');

    const rpc = async (slug: string, token: string | null, body: unknown) => {
      const res = await fetch(`${running?.url}/w/${slug}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      });
      await res.text();
      return res.status;
    };
    const call = (id: number, name: string, args: unknown) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    expect(await rpc('up', upToken, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).toBe(200);
    expect(await rpc('up', upToken, call(2, 'whoami', {}))).toBe(200);
    // Caller faults: a bad argument and no token at all.
    expect(await rpc('up', upToken, call(3, 'get_assets', { assets: 'SECRET-ARGUMENT' }))).toBe(200);
    expect(await rpc('up', null, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} })).toBe(401);
    // An upstream fault: this workspace's Agility is not there.
    expect(await rpc('down', downToken, call(5, 'whoami', {}))).toBe(200);

    // Shutdown flushes what is still queued.
    await running.close();
    running = undefined;

    const spans = spansOf();
    expect(spans.map((s) => s.name).sort()).toEqual(
      ['other', 'tools/call get_assets', 'tools/call whoami', 'tools/call whoami', 'tools/list'].sort(),
    );
    const faults = spans.map((s) => attr(s, 'agility_bridge.fault')).sort();
    expect(faults).toEqual(['caller', 'caller', 'none', 'none', 'upstream']);
    const errors = spans.filter((s) => s.status.code === 2);
    expect(errors).toHaveLength(1);
    expect(attr(errors[0] as Span, 'agility_bridge.fault')).toBe('upstream');
    expect(String(attr(errors[0] as Span, 'error.type'))).toMatch(/^AB_AGILITY_/);
    // 1 service error of 5 requests: the two caller faults are not in the rate.
    expect(errors.length / spans.length).toBe(1 / 5);

    // Delivered like a collector expects, with the operator's key in a header and nowhere else.
    expect(received.every((r) => r.path === '/v1/traces')).toBe(true);
    expect(received.every((r) => r.headers['x-api-key'] === 'COLLECTOR-SECRET')).toBe(true);
    const all = received.map((r) => r.body).join('\n');
    for (const forbidden of [
      'COLLECTOR-SECRET',
      'SECRET-ARGUMENT',
      'Secret workspace',
      'ann@example.test',
      upToken,
      downToken,
      '1.NotARealToken',
      '/Nowhere',
      '127.0.0.1',
      'up/mcp',
    ]) {
      expect(all, forbidden).not.toContain(forbidden);
    }
    expect(lines.join('\n')).not.toContain('COLLECTOR-SECRET');
  });
});
