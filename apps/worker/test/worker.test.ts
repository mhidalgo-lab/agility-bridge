// SPDX-License-Identifier: Apache-2.0
// The bundled Worker in workerd (P3-01): Miniflare with a local D1, no Cloudflare account. Setup goes through the
// Worker's own admin API with the break-glass token; MCP calls use a device token against the synthetic Agility.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAdminToken, generateMasterKey } from '@agility-bridge/auth';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FixtureAgility, startFixtureAgility } from '../../../scripts/fixture-agility.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'dist', 'index.js');
const ORIGIN = 'http://127.0.0.1';
const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
};

let agility: FixtureAgility;
let persist: string;
const running: Miniflare[] = [];

beforeAll(async () => {
  // The bundle CI deploys, built the same way (`wrangler deploy --dry-run`).
  execFileSync(join(ROOT, 'node_modules', '.bin', 'wrangler'), ['deploy', '--dry-run', '--outdir', 'dist'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  agility = await startFixtureAgility();
});
afterAll(() => agility.close());
afterEach(async () => {
  await Promise.all(running.splice(0).map((mf) => mf.dispose()));
  if (persist !== undefined) rmSync(persist, { recursive: true, force: true });
});

function worker(bindings: Record<string, string>, persistTo?: string): Miniflare {
  // Miniflare 5 (the version wrangler 4.149 pins) takes a new options shape; the v4 shape converts to it.
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: SCRIPT,
      compatibilityDate: '2026-09-26',
      d1Databases: ['DB'],
      ...(persistTo === undefined ? {} : { resourcePersistencePath: persistTo }),
      bindings: { AB_ENVIRONMENT: 'test', ...bindings },
    }),
  );
  running.push(mf);
  return mf;
}

async function call(mf: Miniflare, path: string, init: RequestInit = {}): Promise<Response> {
  return (await mf.dispatchFetch(`${ORIGIN}${path}`, init as never)) as unknown as Response;
}

/** Instance, shared credential, workspace(s), service grant and a device token, through the admin API. */
async function setUp(mf: Miniflare, admin: string, workspaces: { slug: string; scope: string }[]) {
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await call(mf, `/api/admin/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    expect(res.status, `${method} ${path}: ${JSON.stringify(json).slice(0, 200)}`).toBeLessThan(300);
    return json;
  };
  const instance = await api('POST', '/instances', { label: 'Synthetic', baseUrl: agility.url });
  const credential = await api('POST', '/credentials', {
    instanceId: instance['id'],
    ownerUserId: null,
    label: 'service',
    token: 'synthetic-service-token-any-value',
  });
  expect(credential['validationStatus']).toBe('valid');
  const tokens: Record<string, string> = {};
  for (const w of workspaces) {
    const ws = await api('POST', '/workspaces', {
      slug: w.slug,
      name: w.slug,
      instanceId: instance['id'],
      allowedScopeIds: [w.scope],
      defaultCredentialId: credential['id'],
    });
    const grant = await api('POST', '/grants', { workspaceId: ws['id'], userId: null, label: 'service' });
    const issued = await api('POST', `/grants/${(grant['record'] as { id: string }).id}/tokens`, {
      label: 'ci',
    });
    tokens[w.slug] = issued['token'] as string;
  }
  return tokens;
}

function mcp(mf: Miniflare, slug: string, token: string | null, body: unknown) {
  return call(mf, `/w/${slug}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
}

const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
const search = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'search_work_items', arguments: { limit: 5 } },
};

describe('the bundle', () => {
  it('has no Node built-in (no nodejs_compat, ADR-0004)', () => {
    const code = readFileSync(SCRIPT, 'utf8');
    expect(code).not.toMatch(/(?:from|import\(|require\()\s*['"]node:/);
    expect(code.length).toBeGreaterThan(100_000);
  });
});

describe('the Worker in workerd', () => {
  it('serves MCP to a device token, the admin API to the break-glass token, and nothing to anyone else', async () => {
    const admin = generateAdminToken();
    const mf = worker({ AB_MASTER_KEY: generateMasterKey(1), AB_ADMIN_TOKEN: admin });
    expect(await (await call(mf, '/health')).json()).toEqual({ status: 'ok' });
    const tokens = await setUp(mf, admin, [{ slug: 'team', scope: 'Scope:1001' }]);

    const tools = await mcp(mf, 'team', tokens['team'] as string, list);
    expect(tools.status).toBe(200);
    expect(await tools.text()).toContain('search_work_items');
    const result = await (await mcp(mf, 'team', tokens['team'] as string, search)).text();
    expect(result).toContain('B-01001');
    expect(result).not.toContain('"isError":true');

    const denied = await mcp(mf, 'team', null, list);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('x-content-type-options')).toBe('nosniff');
    const wrongWorkspace = await mcp(mf, 'nope', tokens['team'] as string, list);
    expect(wrongWorkspace.status).toBe(401);
    expect(await wrongWorkspace.text()).toBe(await denied.clone().text());
    expect((await call(mf, '/api/admin/v1/users')).status).toBe(401);

    // Audit rows were written through waitUntil (detached writes, L-096).
    let audit: { action: string }[] = [];
    for (let i = 0; i < 20 && !audit.some((r) => r.action === 'search_work_items'); i++) {
      const res = await call(mf, '/api/admin/v1/audit?kind=tool_call', {
        headers: { authorization: `Bearer ${admin}` },
      });
      audit = (await res.json()) as { action: string }[];
      if (!audit.some((r) => r.action === 'search_work_items')) await new Promise((r) => setTimeout(r, 50));
    }
    expect(audit.map((r) => r.action)).toContain('search_work_items');
  });

  it('keeps two workspaces apart under 24 interleaved calls (P2-12 on workerd, T21)', async () => {
    const admin = generateAdminToken();
    const mf = worker({ AB_MASTER_KEY: generateMasterKey(1), AB_ADMIN_TOKEN: admin });
    const tokens = await setUp(mf, admin, [
      { slug: 'team-a', scope: 'Scope:1001' },
      { slug: 'team-b', scope: 'Scope:2002' },
    ]);
    const calls = Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? 'team-a' : 'team-b'));
    const results = await Promise.all(
      calls.map(async (slug) => ({
        slug,
        text: await (await mcp(mf, slug, tokens[slug] as string, search)).text(),
      })),
    );
    for (const r of results) {
      if (r.slug === 'team-a') expect(r.text).toContain('B-01001');
      else expect(r.text).not.toContain('B-01001');
    }
  });

  it('boots each concurrent first request on its own: none waits on another, all are served', async () => {
    const mf = worker({ AB_MASTER_KEY: generateMasterKey(1) });
    const res = await Promise.all(Array.from({ length: 8 }, () => call(mf, '/health')));
    expect(res.map((r) => r.status)).toEqual(Array(8).fill(200));
  });
});

describe('boot failures', () => {
  const secured = (res: Response) => {
    expect(res.status).toBe(503);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  };

  it('answer 503 with the security headers (HSTS for an HTTPS public URL) and no detail', async () => {
    for (const bindings of [
      {},
      { AB_MASTER_KEY: 'v1:not-a-key' },
      { AB_MASTER_KEY: generateMasterKey(1), AB_LOG_LEVEL: 'loud' },
      { AB_MASTER_KEY: generateMasterKey(1), AB_DB_PATH: '/data/x.db' },
      { AB_MASTER_KEY: generateMasterKey(1), AB_ADMIN_TOKEN: 'ab_admin_letmein' },
    ]) {
      const mf = worker({ ...bindings, AB_PUBLIC_URL: 'https://mcp.example.test' });
      const res = await call(mf, '/w/team/mcp', { method: 'POST', headers: MCP_HEADERS, body: '{}' });
      secured(res);
      expect(res.headers.get('strict-transport-security')).toContain('max-age=');
      const body = await res.text();
      expect(body).toBe('{"error":"temporarily unavailable"}');
      await mf.dispose();
      running.splice(running.indexOf(mf), 1);
    }
  });

  it('refuses a different master key for a database that already has one (key-check values)', async () => {
    persist = mkdtempSync(join(tmpdir(), 'ab-worker-d1-'));
    const first = worker({ AB_MASTER_KEY: generateMasterKey(1) }, persist);
    expect((await call(first, '/health')).status).toBe(200);
    await first.dispose();
    running.splice(running.indexOf(first), 1);
    const second = worker({ AB_MASTER_KEY: generateMasterKey(1) }, persist);
    const res = await call(second, '/health');
    secured(res);
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });
});
