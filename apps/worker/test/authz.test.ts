// SPDX-License-Identifier: Apache-2.0
// The authorization matrix of P2-12 on workerd (P3-06, L-121, THREAT_MODEL T2, T3, T15, T19): every denied principal
// × initialize, tools/list and every tool gets 401 with one body, reaches no Agility, changes nothing and leaves an
// `auth` audit row with its reason (written through waitUntil) carrying the CF-Connecting-IP address. The world is built
// from Node on the Worker's own local D1 with the same master key; each denial runs on its own Worker and database.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessServices, generateDeviceToken, generateMasterKey, Keyring } from '@agility-bridge/auth';
import { CORE_TOOLS } from '@agility-bridge/core';
import { createD1Driver, type D1Database, openSqlStorage, type Storage } from '@agility-bridge/storage';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FixtureAgility, startFixtureAgility } from '../../../scripts/fixture-agility.ts';
import { until } from './wait.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'dist', 'index.js');
const CLIENT_IP = '203.0.113.7';

let agility: FixtureAgility;
const running: Miniflare[] = [];
beforeAll(async () => {
  agility = await startFixtureAgility();
});
afterAll(() => agility.close());
afterEach(async () => {
  await Promise.all(running.splice(0).map((mf) => mf.dispose()));
});

interface World {
  mf: Miniflare;
  storage: Storage;
  now: number;
  tokens: { alice: string; bob: string };
  ids: {
    alice: string;
    aliceGrant: string;
    aliceToken: string;
    aliceCredential: string;
    workspaceA: string;
    instance: string;
  };
}

/** Two members, each with a personal credential and a grant on their own workspace, as in P2-12. */
async function world(): Promise<World> {
  const key = generateMasterKey(1);
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: SCRIPT,
      compatibilityDate: '2026-09-26',
      d1Databases: ['DB'],
      bindings: {
        AB_ENVIRONMENT: 'test',
        AB_MASTER_KEY: key,
        AB_ALLOW_HTTP_INSTANCES: 'on',
        // Every method of the matrix fails authentication; the failure limit has its own tests (P2-07, P3-04).
        AB_RATE_LIMIT_AUTH_FAILURES: '1000',
      },
    }),
  );
  running.push(mf);
  const storage = await openSqlStorage(
    createD1Driver((await mf.getD1Database('DB')) as unknown as D1Database),
  );
  const svc = accessServices({
    storage,
    keyring: await Keyring.create(key),
    tools: new Map(CORE_TOOLS.map((t) => [t.name, { kind: t.kind, group: t.group }])),
    environment: 'test',
  });
  const alice = await svc.users.create({ email: 'alice@example.test', role: 'member' });
  const bob = await svc.users.create({ email: 'bob@example.test', role: 'member' });
  const instance = await svc.instances.create({ label: 'Synthetic', baseUrl: agility.url });
  const cred = async (owner: string) => {
    const c = await svc.credentials.create({
      instanceId: instance.id,
      ownerUserId: owner,
      label: owner,
      token: 'synthetic-token-any-value',
    });
    await storage.credentials.update(c.id, { validationStatus: 'valid' });
    return c.id;
  };
  const aliceCredential = await cred(alice.id);
  const bobCredential = await cred(bob.id);
  const ws = (slug: string, scope: string) =>
    svc.workspaces.create({ slug, name: slug, instanceId: instance.id, allowedScopeIds: [scope] });
  const workspaceA = await ws('team-a', 'Scope:1001');
  const workspaceB = await ws('team-b', 'Scope:2000');
  const aliceGrant = await svc.grants.create({
    workspaceId: workspaceA.id,
    userId: alice.id,
    credentialId: aliceCredential,
  });
  const bobGrant = await svc.grants.create({
    workspaceId: workspaceB.id,
    userId: bob.id,
    credentialId: bobCredential,
  });
  const a = await svc.tokens.issue({ grantId: aliceGrant.record.id, label: 'laptop' });
  const b = await svc.tokens.issue({ grantId: bobGrant.record.id, label: 'laptop' });
  return {
    mf,
    storage,
    now: Date.now(),
    tokens: { alice: a.token, bob: b.token },
    ids: {
      alice: alice.id,
      aliceGrant: aliceGrant.record.id,
      aliceToken: a.record.id,
      aliceCredential,
      workspaceA: workspaceA.id,
      instance: instance.id,
    },
  };
}

async function snapshot(w: World): Promise<string> {
  const s = w.storage;
  const grants = await s.grants.list();
  const tokens = (await Promise.all(grants.map((g) => s.accessTokens.list({ grantId: g.id })))).flat();
  return JSON.stringify([
    await s.users.list(),
    await s.credentials.list(),
    await s.workspaces.list(),
    grants,
    tokens,
  ]);
}

interface Denial {
  name: string;
  reason: string;
  prepare: (w: World) => Promise<{ slug: string; token: string | null }>;
}

const alice =
  (slug = 'team-a') =>
  async (w: World) => ({ slug, token: w.tokens.alice });
const DENIALS: Denial[] = [
  { name: 'no token', reason: 'no_token', prepare: async () => ({ slug: 'team-a', token: null }) },
  {
    name: 'malformed token',
    reason: 'token_malformed',
    prepare: async () => ({ slug: 'team-a', token: 'ab_test_x' }),
  },
  {
    name: 'well-formed unknown token',
    reason: 'token_unknown',
    prepare: async () => ({ slug: 'team-a', token: (await generateDeviceToken('test')).token }),
  },
  {
    name: "another workspace's token",
    reason: 'wrong_workspace',
    prepare: async (w) => ({ slug: 'team-a', token: w.tokens.bob }),
  },
  { name: 'unknown workspace', reason: 'wrong_workspace', prepare: alice('team-zzz') },
  {
    name: 'revoked token',
    reason: 'token_revoked',
    prepare: async (w) => {
      await w.storage.accessTokens.update(w.ids.aliceToken, { revokedAt: w.now });
      return alice()(w);
    },
  },
  {
    name: 'expired token',
    reason: 'token_expired',
    prepare: async (w) => {
      await w.storage.accessTokens.update(w.ids.aliceToken, { expiresAt: w.now - 1 });
      return alice()(w);
    },
  },
  {
    name: 'revoked grant',
    reason: 'grant_revoked',
    prepare: async (w) => {
      await w.storage.grants.update(w.ids.aliceGrant, { revokedAt: w.now });
      return alice()(w);
    },
  },
  {
    name: 'expired grant',
    reason: 'grant_expired',
    prepare: async (w) => {
      await w.storage.grants.update(w.ids.aliceGrant, { expiresAt: w.now - 1 });
      return alice()(w);
    },
  },
  {
    name: 'disabled workspace',
    reason: 'workspace_disabled',
    prepare: async (w) => {
      await w.storage.workspaces.update(w.ids.workspaceA, { disabledAt: w.now });
      return alice()(w);
    },
  },
  {
    name: 'disabled user',
    reason: 'user_disabled',
    prepare: async (w) => {
      await w.storage.users.update(w.ids.alice, { disabledAt: w.now });
      return alice()(w);
    },
  },
  {
    name: 'revoked credential',
    reason: 'credential_revoked',
    prepare: async (w) => {
      await w.storage.credentials.update(w.ids.aliceCredential, { revokedAt: w.now });
      return alice()(w);
    },
  },
  {
    name: 'unvalidated credential',
    reason: 'credential_unvalidated',
    prepare: async (w) => {
      await w.storage.credentials.update(w.ids.aliceCredential, { validationStatus: 'invalid' });
      return alice()(w);
    },
  },
  {
    name: 'disabled instance',
    reason: 'instance_disabled',
    prepare: async (w) => {
      await w.storage.instances.update(w.ids.instance, { disabledAt: w.now });
      return alice()(w);
    },
  },
];

const METHODS = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
  },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ...CORE_TOOLS.map((t, i) => ({
    jsonrpc: '2.0',
    id: 10 + i,
    method: 'tools/call',
    params: { name: t.name, arguments: {} },
  })),
];

async function post(w: World, slug: string, token: string | null, body: unknown): Promise<Response> {
  return (await w.mf.dispatchFetch(`http://127.0.0.1/w/${slug}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
      'cf-connecting-ip': CLIENT_IP,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  })) as unknown as Response;
}

describe('MCP route × principal × method/tool on workerd: every denial denies (P2-12)', () => {
  it('the world itself is served (control)', async () => {
    const w = await world();
    const res = await post(w, 'team-a', w.tokens.alice, METHODS[1]);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"whoami"');
  });

  it.each(DENIALS.map((d) => [d.name, d] as const))('%s', async (_name, denial) => {
    const w = await world();
    const { slug, token } = await denial.prepare(w);
    const before = await snapshot(w);
    const upstream = agility.requests();
    const bodies = new Set<string>();
    for (const message of METHODS) {
      const res = await post(w, slug, token, message);
      expect(res.status, `${message.method} ${JSON.stringify(message.params).slice(0, 40)}`).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      bodies.add(await res.text());
    }
    expect(bodies).toEqual(new Set([JSON.stringify({ error: 'unauthorized' })]));
    expect(agility.requests()).toBe(upstream);
    expect(await snapshot(w)).toBe(before);
    // Written through waitUntil after each response (L-381).
    let rows: Awaited<ReturnType<Storage['audit']['query']>> = [];
    await until(async () => {
      rows = await w.storage.audit.query({ kind: 'auth', limit: 1_000 });
      return rows.length >= METHODS.length;
    });
    expect(rows).toHaveLength(METHODS.length);
    for (const row of rows) expect(row.details).toMatchObject({ reason: denial.reason, ip: CLIENT_IP });
    expect(await w.storage.audit.query({ kind: 'tool_call' })).toEqual([]);
  });
});
