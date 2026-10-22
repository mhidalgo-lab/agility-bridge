// SPDX-License-Identifier: Apache-2.0
// The admin REST API (P2-09): negative authorization for every route and role (L-121, L-065), owner-only actions, the
// break-glass token, secrets never returned, the error envelope, audit rows.
import { AdminTokenVerifier, generateAdminToken } from '@agility-bridge/auth';
import { describe, expect, it } from 'vitest';
import { ADMIN_BASE, adminTokenAuthenticator } from '../src/index.ts';
import { ORIGIN, type World, world } from './helpers/world.ts';

type Who = 'none' | 'member' | 'admin' | 'owner' | 'owner_stale' | 'break_glass';

function call(
  w: World,
  who: Who,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return w.app.fetch(
    new Request(`${ORIGIN}${ADMIN_BASE}${path}`, {
      method,
      headers: {
        ...(who === 'none' ? {} : { 'x-test-actor': who }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
  );
}

/** Everything an admin change could touch, to prove that a refused request changed nothing. */
async function snapshot(w: World): Promise<string> {
  const s = w.storage;
  const grants = await s.grants.list();
  const tokens = (await Promise.all(grants.map((g) => s.accessTokens.list({ grantId: g.id })))).flat();
  return JSON.stringify([
    await s.users.list(),
    await s.instances.list(),
    await s.credentials.list(),
    await s.workspaces.list(),
    grants,
    tokens,
  ]);
}

/** Every route with a plausible body. `{x}` placeholders are filled per world. */
function routes(w: World): [string, string, unknown?][] {
  const ws = w.ids.workspaceA;
  const g = w.ids.aliceGrant;
  return [
    ['GET', '/users'],
    ['POST', '/users', { email: 'new@example.test', role: 'member' }],
    ['GET', `/users/${w.ids.owner}`],
    ['PATCH', `/users/${w.ids.owner}`, { displayName: 'X' }],
    ['POST', `/users/${w.ids.owner}/disable`],
    ['GET', '/instances'],
    ['POST', '/instances', { label: 'New', baseUrl: 'https://new.example.test/x' }],
    ['GET', `/instances/${w.ids.instance}`],
    ['PATCH', `/instances/${w.ids.instance}`, { label: 'Renamed' }],
    ['POST', `/instances/${w.ids.instance}/retarget`, { baseUrl: 'https://evil.example.test/x' }],
    ['DELETE', `/instances/${w.ids.instance}`],
    ['GET', '/keys'],
    ['POST', '/keys/1/retire', { reason: 'x' }],
    ['GET', '/credentials'],
    [
      'POST',
      '/credentials',
      { instanceId: w.ids.instance, ownerUserId: null, label: 'svc', token: '1.SharedTokenNotRealAbCd' },
    ],
    ['GET', `/credentials/${w.ids.bobCredential}`],
    ['PATCH', `/credentials/${w.ids.bobCredential}`, { label: 'x' }],
    ['POST', `/credentials/${w.ids.bobCredential}/token`, { token: '1.ReplacementNotRealAbCd' }],
    ['POST', `/credentials/${w.ids.bobCredential}/revoke`],
    ['DELETE', `/credentials/${w.ids.bobCredential}`],
    ['GET', '/workspaces'],
    [
      'POST',
      '/workspaces',
      { slug: 'new', name: 'New', instanceId: w.ids.instance, allowedScopeIds: ['Scope:1'] },
    ],
    ['GET', `/workspaces/${ws}`],
    ['PATCH', `/workspaces/${ws}`, { name: 'Renamed' }],
    ['POST', `/workspaces/${ws}/disable`],
    ['DELETE', `/workspaces/${ws}`],
    ['GET', '/grants'],
    ['POST', '/grants', { workspaceId: ws, userId: w.ids.owner }],
    ['GET', `/grants/${g}`],
    ['PATCH', `/grants/${g}`, { label: 'x' }],
    ['POST', `/grants/${g}/revoke`],
    ['DELETE', `/grants/${g}`],
    ['GET', `/grants/${g}/tokens`],
    ['POST', `/grants/${g}/tokens`, { label: 'device' }],
    ['POST', `/tokens/${w.ids.aliceToken}/revoke`],
    ['GET', '/audit'],
    ['GET', '/openapi.json'],
  ];
}

describe('negative authorization (every route)', () => {
  it('without credentials every route answers 401 and changes nothing', async () => {
    const w = await world({}, { admin: true });
    const before = await snapshot(w);
    for (const [method, path, body] of routes(w)) {
      const res = await call(w, 'none', method, path, body);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(await res.json()).toEqual({
        error: { code: 'unauthorized', message: 'Authentication required.' },
      });
    }
    expect(await snapshot(w)).toBe(before);
  });

  it('a member manages only their own credentials and grant tokens: every other route is refused, nothing changes', async () => {
    const w = await world({}, { admin: true });
    const before = await snapshot(w);
    const allowedForMember = new Set([
      'GET /users', // lists only themselves
      'GET /instances',
      `GET /instances/${w.ids.instance}`,
      'GET /credentials', // only their own
      'GET /grants', // only their own
      `GET /grants/${w.ids.aliceGrant}`,
      `GET /grants/${w.ids.aliceGrant}/tokens`,
      `POST /grants/${w.ids.aliceGrant}/tokens`,
      `POST /tokens/${w.ids.aliceToken}/revoke`,
      'GET /openapi.json',
    ]);
    for (const [method, path, body] of routes(w)) {
      if (allowedForMember.has(`${method} ${path}`)) continue;
      const res = await call(w, 'member', method, path, body);
      expect([403, 404], `${method} ${path}`).toContain(res.status);
    }
    expect(await snapshot(w)).toBe(before);
    // What a member sees is only theirs.
    expect(
      (await (await call(w, 'member', 'GET', '/users')).json()).map((u: { id: string }) => u.id),
    ).toEqual([w.ids.alice]);
    const creds = (await (await call(w, 'member', 'GET', '/credentials')).json()) as {
      ownerUserId: string;
    }[];
    expect(creds.map((c) => c.ownerUserId)).toEqual([w.ids.alice]);
    const grants = (await (await call(w, 'member', 'GET', '/grants')).json()) as { userId: string }[];
    expect(new Set(grants.map((g) => g.userId))).toEqual(new Set([w.ids.alice]));
  });

  it('an admin cannot do owner-only things: change an origin, create owners, enable writes, disable an owner', async () => {
    const w = await world({}, { admin: true });
    const before = await snapshot(w);
    const ownerOnly: [string, string, unknown?][] = [
      ['POST', `/instances/${w.ids.instance}/retarget`, { baseUrl: 'https://evil.example.test/x' }],
      ['GET', '/keys'],
      ['POST', '/keys/1/retire', { reason: 'x' }],
      ['POST', '/users', { email: 'boss@example.test', role: 'owner' }],
      ['POST', '/users', { email: 'adm@example.test', role: 'admin' }],
      ['PATCH', `/users/${w.ids.alice}`, { role: 'admin' }],
      ['PATCH', `/users/${w.ids.owner}`, { displayName: 'x' }],
      ['POST', `/users/${w.ids.owner}/disable`],
      ['PATCH', `/workspaces/${w.ids.workspaceA}`, { writePolicy: { enabled: true } }],
      [
        'POST',
        '/workspaces',
        {
          slug: 'w',
          name: 'W',
          instanceId: w.ids.instance,
          allowedScopeIds: ['Scope:1'],
          writePolicy: { enabled: true },
        },
      ],
    ];
    for (const [method, path, body] of ownerOnly) {
      const res = await call(w, 'admin', method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await res.json()).error.code).toBe('forbidden');
    }
    expect(await snapshot(w)).toBe(before);
    const denied = await w.storage.audit.query({ kind: 'admin', status: 'denied', limit: 100 });
    // Every refused change is recorded; reads (GET /keys) are not audited.
    expect(denied.length).toBe(ownerOnly.filter(([method]) => method !== 'GET').length);
  });

  it('nobody stores a personal token for someone else, not even the break-glass token', async () => {
    const w = await world({}, { admin: true });
    const body = {
      instanceId: w.ids.instance,
      ownerUserId: w.ids.alice,
      label: 'x',
      token: '1.SomeoneElsesTokenAbCdEf',
    };
    for (const who of ['admin', 'owner', 'break_glass'] as const) {
      expect((await call(w, who, 'POST', '/credentials', body)).status, who).toBe(403);
    }
    const own = await call(w, 'member', 'POST', '/credentials', body);
    expect(own.status).toBe(201);
  });
});

describe("personal Agility tokens stay their owner's (P2-17 review M2)", () => {
  it("nobody but the owner issues a device token on a grant that uses a member's personal credential", async () => {
    const w = await world({}, { admin: true });
    const before = (await w.storage.accessTokens.list({ grantId: w.ids.aliceGrant })).length;
    for (const who of ['admin', 'owner', 'break_glass'] as const) {
      const res = await call(w, who, 'POST', `/grants/${w.ids.aliceGrant}/tokens`, { label: 'stolen' });
      expect(res.status, who).toBe(403);
    }
    expect((await w.storage.accessTokens.list({ grantId: w.ids.aliceGrant })).length).toBe(before);
    expect(
      (await call(w, 'member', 'POST', `/grants/${w.ids.aliceGrant}/tokens`, { label: 'mine' })).status,
    ).toBe(201);
  });

  it("an existing grant cannot be moved onto someone's personal credential", async () => {
    const w = await world({}, { admin: true });
    await w.storage.credentials.create({
      id: 'c-shared',
      instanceId: w.ids.instance,
      ownerUserId: null,
      label: 'shared',
      tokenCiphertext: 'x',
      tokenIv: 'y',
      keyVersion: 1,
      tokenHint: 'abcd',
    });
    const created = await call(w, 'owner', 'POST', '/grants', {
      workspaceId: w.ids.workspaceA,
      userId: w.ids.alice,
      credentialId: 'c-shared',
    });
    expect(created.status).toBe(201);
    const grant = (await created.json()) as { record: { id: string } };
    const res = await call(w, 'owner', 'PATCH', `/grants/${grant.record.id}`, {
      credentialId: w.ids.aliceCredential,
    });
    expect(res.status).toBe(403);
  });
});

describe('owner actions', () => {
  it('master keys (P3-13): an owner sees the versions; retiring needs a recent sign-in and an unused version', async () => {
    const w = await world({}, { admin: true });
    const status = await call(w, 'owner', 'GET', '/keys');
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual([
      { version: 1, credentials: 2, loaded: true, current: true, retired: false },
    ]);
    expect((await call(w, 'owner_stale', 'POST', '/keys/1/retire', { reason: 'x' })).status).toBe(403);
    const current = await call(w, 'break_glass', 'POST', '/keys/1/retire', { reason: 'x' });
    expect(current.status).toBe(409);
    expect(JSON.stringify(await current.json())).toContain('current key');
    expect((await call(w, 'break_glass', 'POST', '/keys/0/retire', { reason: 'x' })).status).toBe(422);
    expect((await call(w, 'break_glass', 'POST', '/keys/1/retire', {})).status).toBe(422);
    expect(await w.storage.kv.get('crypto:retired:v1')).toBeNull();
  });

  it('an owner retargets an instance only after a recent sign-in, and the change revokes its credentials and grants', async () => {
    const w = await world({}, { admin: true });
    const body = { baseUrl: 'https://agility2.example.test/Main' };
    expect((await call(w, 'owner_stale', 'POST', `/instances/${w.ids.instance}/retarget`, body)).status).toBe(
      403,
    );
    const res = await call(w, 'owner', 'POST', `/instances/${w.ids.instance}/retarget`, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ revokedCredentials: 2, revokedGrants: 3 });
    for (const c of await w.storage.credentials.list()) expect(c.revokedAt).not.toBeNull();
    const [row] = await w.storage.audit.query({ kind: 'admin', status: 'ok' });
    expect(row).toMatchObject({
      action: 'instance.retarget',
      targetId: w.ids.instance,
      details: { actor: 'owner', via: 'api' },
    });
  });

  it('the last active owner cannot be demoted or disabled', async () => {
    const w = await world({}, { admin: true });
    expect((await call(w, 'owner', 'POST', `/users/${w.ids.owner}/disable`)).status).toBe(403);
    expect((await call(w, 'owner', 'PATCH', `/users/${w.ids.owner}`, { role: 'admin' })).status).toBe(403);
    expect(
      (await call(w, 'owner', 'POST', '/users', { email: 'second@example.test', role: 'owner' })).status,
    ).toBe(201);
    expect((await call(w, 'owner', 'POST', `/users/${w.ids.owner}/disable`)).status).toBe(200);
  });
});

describe('secrets are never returned', () => {
  it('credentials show only a hint; tokens are shown once at issue and never listed', async () => {
    const w = await world({}, { admin: true });
    const token = '1.ServiceTokenNotRealAbCdEfGhIj9999';
    const created = await call(w, 'admin', 'POST', '/credentials', {
      instanceId: w.ids.instance,
      ownerUserId: null,
      label: 'svc',
      token,
    });
    const text = await created.text();
    expect(created.status).toBe(201);
    expect(text).toContain('"tokenHint":"9999"');
    for (const leak of [token, 'tokenCiphertext', 'tokenIv']) expect(text).not.toContain(leak);
    const listed = await (await call(w, 'admin', 'GET', '/credentials')).text();
    for (const leak of [token, 'tokenCiphertext', 'tokenIv']) expect(listed).not.toContain(leak);

    // Alice's grant uses her personal token: she issues her own device tokens (P2-17 review M2).
    const issued = (await (
      await call(w, 'member', 'POST', `/grants/${w.ids.aliceGrant}/tokens`, { label: 'ci' })
    ).json()) as {
      token: string;
      record: Record<string, unknown>;
    };
    expect(issued.token).toMatch(/^ab_live_/);
    expect(issued.record).not.toHaveProperty('tokenHash');
    const tokens = await (await call(w, 'admin', 'GET', `/grants/${w.ids.aliceGrant}/tokens`)).text();
    expect(tokens).not.toContain(issued.token.slice(12));
    expect(tokens).not.toContain('tokenHash');
    const audit = JSON.stringify(await w.storage.audit.query({ limit: 1_000 }));
    for (const leak of [token, issued.token.slice(12)]) expect(audit).not.toContain(leak);
    expect(audit).toContain('credential.create');
  });
});

describe('the break-glass admin token', () => {
  it('refuses hand-made or weak values at boot', async () => {
    for (const weak of [
      '',
      'admin',
      'ab_admin_password123',
      `ab_admin_${'a'.repeat(43)}_000000`,
      generateAdminToken().slice(0, -1),
    ]) {
      await expect(AdminTokenVerifier.create(weak)).rejects.toThrow(
        /generated by `agility-bridge admin-token`/,
      );
    }
  });

  it('authenticates only the configured token; failures are rate-limited by the shared failure budget', async () => {
    const token = generateAdminToken();
    const verifier = await AdminTokenVerifier.create(`${token}\n`);
    const base = await world({}, { admin: true });
    const w = await world({
      admin: {
        services: undefined as never,
        audit: base.audit,
        authenticate: adminTokenAuthenticator(verifier),
      },
    });
    const get = (auth?: string) =>
      w.app.fetch(
        new Request(`${ORIGIN}${ADMIN_BASE}/openapi.json`, {
          headers: auth === undefined ? {} : { authorization: `Bearer ${auth}` },
        }),
      );
    expect((await get(token)).status).toBe(200);
    expect((await get(generateAdminToken())).status).toBe(401);
    expect((await get(w.tokens.alice)).status).toBe(401);
    expect((await get()).status).toBe(401);
  });

  it('without an admin authenticator the whole API is 404', async () => {
    const w = await world();
    for (const [method, path, body] of routes(w)) {
      expect((await call(w, 'owner', method, path, body)).status, `${method} ${path}`).toBe(404);
    }
  });
});

describe('requests and errors', () => {
  it('validates bodies with the error envelope: 400, 415, 413, 422 (with the field), 404, 409', async () => {
    const w = await world({}, { admin: true });
    expect((await call(w, 'admin', 'POST', '/users', '{nope')).status).toBe(400);
    expect((await call(w, 'admin', 'POST', '/users', 'x', { 'content-type': 'text/plain' })).status).toBe(
      415,
    );
    expect(
      (await call(w, 'admin', 'POST', '/users', { email: 'x'.repeat(70_000), role: 'member' })).status,
    ).toBe(413);
    const bad = await call(w, 'admin', 'POST', '/users', { email: 'a@example.test', role: 'root' });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error).toMatchObject({ code: 'invalid_input', field: 'role' });
    const extra = await call(w, 'admin', 'POST', '/users', {
      email: 'a@example.test',
      role: 'member',
      isOwner: true,
    });
    expect(extra.status).toBe(422);
    const domain = await call(w, 'admin', 'POST', '/workspaces', {
      slug: 'x',
      name: 'X',
      instanceId: w.ids.instance,
      allowedScopeIds: ['Epic:1'],
    });
    expect(domain.status).toBe(422);
    expect((await domain.json()).error.code).toBe('invalid_input');
    expect((await call(w, 'admin', 'GET', '/users/usr_404')).status).toBe(404);
    expect(
      (await call(w, 'admin', 'POST', '/users', { email: 'alice@example.test', role: 'member' })).status,
    ).toBe(409);
    expect((await call(w, 'admin', 'DELETE', `/credentials/${w.ids.aliceCredential}`)).status).toBe(409);
  });

  it('a change clears the access cache, so a revoked grant stops at once', async () => {
    const w = await world({ accessCacheTtlSeconds: 60 }, { admin: true });
    const list = () =>
      w.app.fetch(
        new Request(`${ORIGIN}/w/team-a/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${w.tokens.alice}`,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }),
      );
    expect((await list()).status).toBe(200);
    expect((await call(w, 'admin', 'POST', `/grants/${w.ids.aliceGrant}/revoke`)).status).toBe(200);
    expect((await list()).status).toBe(401);
  });

  it('serves its OpenAPI document', async () => {
    const w = await world({}, { admin: true });
    const doc = (await (await call(w, 'admin', 'GET', '/openapi.json')).json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/instances/{id}/retarget');
  });
});
