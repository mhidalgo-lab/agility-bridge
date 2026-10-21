// SPDX-License-Identifier: Apache-2.0
// `agility-bridge serve` on a real socket (P2-06): configuration checks before listening, a token-authenticated MCP
// request over Node HTTP, uniform 401, headers and health.
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accessServices, generateAdminToken, generateMasterKey, Keyring } from '@agility-bridge/auth';
import { CORE_TOOLS } from '@agility-bridge/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureAgility, startFixtureAgility } from '../../../scripts/fixture-agility.ts';
import { ConfigError } from '../src/config.ts';
import { loadServeConfig, type RunningServer, startServe } from '../src/serve.ts';

let dir: string;
let agility: FixtureAgility;
beforeAll(async () => {
  agility = await startFixtureAgility();
});
afterAll(() => agility.close());
let running: RunningServer | undefined;
const KEY = generateMasterKey(1);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ab-serve-'));
  writeFileSync(join(dir, 'master.key'), KEY, { mode: 0o600 });
});
afterEach(async () => {
  await running?.close();
  running = undefined;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // Windows may keep the database locked a moment longer (L-104).
  }
});

const env = (over: Record<string, string> = {}) => ({
  AB_DATA_DIR: join(dir, 'data'),
  AB_MASTER_KEY_FILE: join(dir, 'master.key'),
  AB_PORT: '0',
  ...over,
});

describe('serve configuration', () => {
  it('defaults to loopback, port 8787, a 30 s access cache and production tokens', () => {
    expect(loadServeConfig({ AB_DATA_DIR: '/d' })).toMatchObject({
      dbPath: join('/d', 'agility-bridge.db'),
      host: '127.0.0.1',
      port: 8787,
      accessCacheTtlSeconds: 30,
      environment: 'live',
    });
    expect(loadServeConfig({ AB_DB_PATH: '/x/y.db', AB_ENVIRONMENT: 'test' })).toMatchObject({
      dbPath: '/x/y.db',
      environment: 'test',
    });
  });

  it('refuses bad values before listening', () => {
    for (const bad of [
      { AB_PORT: '70000' },
      { AB_ACCESS_CACHE_TTL: '61' },
      { AB_ENVIRONMENT: 'prod' },
      { AB_PUBLIC_URL: 'https://mcp.example.com/path?x=1' },
      { AB_PUBLIC_URL: 'ftp://mcp.example.com' },
      { AB_ALLOWED_ORIGINS: 'null' },
      { AB_TYPO: '1' },
    ]) {
      expect(() => loadServeConfig(bad), JSON.stringify(bad)).toThrow(ConfigError);
    }
  });

  it('refuses to start without a master key, or with one inside the data directory', async () => {
    await expect(startServe({ AB_DATA_DIR: join(dir, 'data'), AB_PORT: '0' })).rejects.toThrow(/master key/);
    const inside = join(dir, 'data');
    await expect(
      startServe({ AB_DATA_DIR: dir, AB_MASTER_KEY_FILE: join(dir, 'master.key'), AB_PORT: '0' }),
    ).rejects.toThrow(/inside the data directory/);
    expect(inside).toBeTruthy();
  });

  it('refuses a different key for a database that already has one', async () => {
    running = await startServe(env(), { sink: () => {} });
    await running.close();
    running = undefined;
    await expect(
      startServe(env({ AB_MASTER_KEY_FILE: '', AB_MASTER_KEY: generateMasterKey(1) }), { sink: () => {} }),
    ).rejects.toThrow(ConfigError);
  });
});

describe('serve over HTTP', () => {
  it('serves a workspace to its device token and nothing to anyone else', async () => {
    const lines: string[] = [];
    running = await startServe(env(), { sink: (l) => lines.push(l) });
    if (process.platform !== 'win32') expect(statSync(running.storage.path).mode & 0o777).toBe(0o600);
    const svc = accessServices({
      storage: running.storage,
      keyring: await Keyring.create(KEY),
      tools: new Map(CORE_TOOLS.map((t) => [t.name, { kind: t.kind, group: t.group }])),
    });
    const user = await svc.users.create({ email: 'ann@example.test', role: 'member' });
    const inst = await svc.instances.create({ label: 'x', baseUrl: 'https://agility.example.test/x' });
    const cred = await svc.credentials.create({
      instanceId: inst.id,
      ownerUserId: user.id,
      label: 'c',
      token: '1.NotARealTokenAbCdEfGh',
    });
    await running.storage.credentials.update(cred.id, { validationStatus: 'valid' });
    const ws = await svc.workspaces.create({
      slug: 'team',
      name: 'Team',
      instanceId: inst.id,
      allowedScopeIds: ['Scope:1'],
    });
    const grant = await svc.grants.create({ workspaceId: ws.id, userId: user.id, credentialId: cred.id });
    const { token } = await svc.tokens.issue({ grantId: grant.record.id, label: 'laptop' });

    const call = (auth: string | null) =>
      fetch(`${running?.url}/w/team/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
          ...(auth === null ? {} : { authorization: `Bearer ${auth}` }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
    const ok = await call(token);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('whoami');
    const denied = await call(null);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await (await fetch(`${running.url}/health`)).json()).toEqual({ status: 'ok' });
    const log = lines.join('\n');
    expect(log).toContain('"refusal":"no_token"');
    expect(log).not.toContain(token);
    expect(log).not.toContain(KEY.slice(3));
  });
});

describe('admin API through serve', () => {
  it('is 404 without an admin token, and served to the configured one', async () => {
    running = await startServe(env(), { sink: () => {} });
    expect((await fetch(`${running.url}/api/admin/v1/users`)).status).toBe(404);
    await running.close();
    running = undefined;
    const token = generateAdminToken();
    writeFileSync(join(dir, 'admin.token'), `${token}\n`, { mode: 0o600 });
    running = await startServe(env({ AB_ADMIN_TOKEN_FILE: join(dir, 'admin.token') }), { sink: () => {} });
    const auth = { authorization: `Bearer ${token}` };
    expect((await fetch(`${running.url}/api/admin/v1/users`)).status).toBe(401);
    const created = await fetch(`${running.url}/api/admin/v1/instances`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Main', baseUrl: agility.url }),
    });
    expect(created.status).toBe(201);
    expect(
      ((await (await fetch(`${running.url}/api/admin/v1/instances`, { headers: auth })).json()) as unknown[])
        .length,
    ).toBe(1);
    await running.audit.flush();
    const [row] = await running.storage.audit.query({ kind: 'admin' });
    expect(row).toMatchObject({ action: 'instance.create', details: { actor: 'break_glass', via: 'api' } });
  });

  it('refuses a hand-made admin token, or one in the data directory, before listening', async () => {
    await expect(startServe(env({ AB_ADMIN_TOKEN: 'ab_admin_letmein' }), { sink: () => {} })).rejects.toThrow(
      /generated by `agility-bridge admin-token`/,
    );
    await expect(
      startServe(env({ AB_ADMIN_TOKEN_FILE: join(dir, 'data', 'admin.token') }), { sink: () => {} }),
    ).rejects.toThrow(/inside the data directory/);
  });
});

describe('revalidation after repeated Agility refusals', () => {
  it('revalidates after 3 consecutive AB_AGILITY_AUTH errors, at most once per 10 minutes, and resets on success', async () => {
    const { revalidateOnAuthErrors } = await import('../src/serve.ts');
    const validated: string[] = [];
    let t = 1_000_000;
    const services = {
      credentials: {
        validate: async (id: string) => (validated.push(id), { id, validationStatus: 'invalid' }),
      },
    };
    const trigger = revalidateOnAuthErrors(
      services as never,
      { warn: () => {}, error: () => {} } as never,
      () => t,
    );
    trigger('c1', 'AB_AGILITY_AUTH');
    trigger('c1', 'AB_AGILITY_AUTH');
    trigger('c1', null); // a success in between resets the streak
    trigger('c1', 'AB_AGILITY_AUTH');
    trigger('c1', 'AB_AGILITY_AUTH');
    expect(validated).toEqual([]);
    trigger('c1', 'AB_AGILITY_AUTH');
    await Promise.resolve();
    expect(validated).toEqual(['c1']);
    for (let i = 0; i < 3; i++) trigger('c1', 'AB_AGILITY_AUTH');
    expect(validated).toEqual(['c1']);
    t += 600_000;
    for (let i = 0; i < 3; i++) trigger('c1', 'AB_AGILITY_AUTH');
    expect(validated).toEqual(['c1', 'c1']);
  });
});
