// SPDX-License-Identifier: Apache-2.0
// Phase 4 admin security review over HTTP (P4-09, THREAT_MODEL T14, T20, A5, A14, ADR-0013, L-065, L-093, L-121): the writers
// through real sessions and memory storage. Tests named `fix: ...` failed with their fix reverted (checked one by one); the
// others record what holds. A refusal changes nothing.
import { describe, expect, it } from 'vitest';
import { MIN, setup } from './helpers/panel.ts';
import { post, TOOL_INFO } from './helpers/world.ts';

const OWNER = 'owner@example.test';
const ADMIN = 'admin@example.test';
const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';
const WRITE_TOOL = 'update_work_item';
const TOOLS = new Map([...TOOL_INFO, [WRITE_TOOL, { kind: 'write' as const, group: 'work' }]]);

type S = Awaited<ReturnType<typeof setup>>;

/** A token-shaped value built at run time (gitleaks). */
const secret = (label: string): string => `1.${label}${crypto.randomUUID().replaceAll('-', '')}`;

async function env() {
  const s = await setup({ tools: TOOLS });
  const owner = await s.session(OWNER);
  const admin = await s.session(ADMIN);
  const alice = await s.session(ALICE);
  const bob = await s.session(BOB);
  const workspaces = await s.w.storage.workspaces.list();
  const team = (slug: string) => workspaces.find((w) => w.slug === slug)?.id as string;
  const bobId = (await s.w.storage.users.list()).find((u) => u.email === BOB)?.id as string;
  return {
    s,
    owner,
    admin,
    alice,
    bob,
    ids: { ...s.w.ids, bob: bobId, teamA: team('team-a'), teamB: team('team-b') },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: the tests read many fields of admin API answers
const json = async (res: Response) => (await res.json()) as any;
const snapshot = async (s: S) =>
  JSON.stringify({
    users: await s.w.storage.users.list(),
    instances: await s.w.storage.instances.list(),
    workspaces: await s.w.storage.workspaces.list(),
    grants: await s.w.storage.grants.list(),
    tokens: await s.w.storage.accessTokens.list(),
    credentials: await s.w.storage.credentials.list(),
  });

describe("the API holds the owners' boundaries that the panel already showed", () => {
  it('fix: an admin cannot add an instance with a CA file, whatever the panel form says (A14)', async () => {
    const { s, admin, owner } = await env();
    const before = await snapshot(s);
    const body = {
      label: 'Other',
      baseUrl: 'https://other.example.test/Main',
      tls: { caFile: '/etc/ssl/any.pem' },
    };
    const refused = await s.api('POST', '/instances', admin, body);
    expect(refused.status).toBe(403);
    expect((await json(refused)).error.code).toBe('forbidden');
    expect(await snapshot(s)).toBe(before);
    // Without a CA file an admin still adds an instance; an owner may set one with a recent sign-in.
    expect(
      (
        await s.api('POST', '/instances', admin, {
          label: 'Plain',
          baseUrl: 'https://plain.example.test/Main',
        })
      ).status,
    ).toBe(201);
    s.w.now.t += 11 * MIN;
    const stale = await s.api('POST', '/instances', owner, body);
    expect(stale.status).toBe(403);
    expect((await json(stale)).error.code).toBe('reauth_required');
    s.w.now.t -= 11 * MIN;
    expect((await s.api('POST', '/instances', owner, body)).status).toBe(201);
  });

  it('fix: an owner with an old sign-in cannot make a workspace pass-through', async () => {
    const { s, owner, ids } = await env();
    const before = await snapshot(s);
    s.w.now.t += 11 * MIN;
    const res = await s.api('PATCH', `/workspaces/${ids.teamA}`, owner, { credentialSource: 'passthrough' });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('reauth_required');
    expect(await snapshot(s)).toBe(before);
  });

  it('fix: an admin cannot widen where an owner enabled writes; narrowing and other edits still work', async () => {
    const { s, owner, admin, ids } = await env();
    const enabled = await s.api('PATCH', `/workspaces/${ids.teamB}`, owner, {
      enabledTools: ['whoami', WRITE_TOOL],
      writePolicy: { enabled: true },
    });
    expect(enabled.status).toBe(200);
    const before = await snapshot(s);
    for (const patch of [{ allowedScopeIds: ['Scope:2001', 'Scope:1001'] }, { includeChildScopes: true }]) {
      const res = await s.api('PATCH', `/workspaces/${ids.teamB}`, admin, patch);
      expect(res.status, JSON.stringify(patch)).toBe(403);
    }
    expect(await snapshot(s)).toBe(before);
    expect(
      (
        await s.api('PATCH', `/workspaces/${ids.teamB}`, admin, {
          name: 'Team B 2',
          allowedScopeIds: ['Scope:2001'],
        })
      ).status,
    ).toBe(200);
    s.w.now.t += 11 * MIN;
    const stale = await s.api('PATCH', `/workspaces/${ids.teamB}`, owner, {
      allowedScopeIds: ['Scope:2001', 'Scope:1001'],
    });
    expect((await json(stale)).error.code).toBe('reauth_required');
    s.w.now.t -= 11 * MIN;
    expect(
      (
        await s.api('PATCH', `/workspaces/${ids.teamB}`, owner, {
          allowedScopeIds: ['Scope:2001', 'Scope:1001'],
        })
      ).status,
    ).toBe(200);
  });

  it('fix: a member with an old sign-in cannot mint a device token that outlives the default', async () => {
    const { s, alice, ids } = await env();
    s.w.now.t += 11 * MIN;
    const before = await snapshot(s);
    for (const expiresInDays of ['never', 400]) {
      const res = await s.api('POST', `/grants/${ids.aliceGrant}/tokens`, alice, {
        label: 'persist',
        expiresInDays,
      });
      expect(res.status, String(expiresInDays)).toBe(403);
      expect((await json(res)).error.code).toBe('reauth_required');
    }
    expect(await snapshot(s)).toBe(before);
    const ok = await s.api('POST', `/grants/${ids.aliceGrant}/tokens`, alice, {
      label: 'phone',
      expiresInDays: 30,
    });
    expect(ok.status).toBe(201);
  });
});

describe('audit rows say what changed, and never a secret', () => {
  it('fix: a role, a project list, a tool list, a token and an origin are in the row', async () => {
    const { s, owner, alice, ids } = await env();
    const made = await json(
      await s.api('POST', '/users', owner, { email: 'new@example.test', role: 'admin' }),
    );
    expect((await s.api('PATCH', `/users/${made.id}`, owner, { role: 'owner' })).status).toBe(200);
    expect(
      (
        await s.api('PATCH', `/workspaces/${ids.teamB}`, owner, {
          allowedScopeIds: ['Scope:2001', 'Scope:1001'],
          enabledTools: ['whoami', WRITE_TOOL],
          writePolicy: { enabled: true },
          credentialSource: 'stored',
        })
      ).status,
    ).toBe(200);
    const issued = await json(
      await s.api('POST', `/grants/${ids.aliceGrant}/tokens`, alice, {
        label: 'laptop 2',
        expiresInDays: 'never',
      }),
    );
    const instance = await json(
      await s.api('POST', '/instances', owner, {
        label: 'Elsewhere',
        baseUrl: 'https://elsewhere.example.test:8443/Main',
      }),
    );
    const moved = await s.api('POST', `/instances/${instance.id}/retarget`, owner, {
      baseUrl: 'https://moved.example.test/Main',
    });
    expect(moved.status).toBe(200);
    const personal = await json(
      await s.api('POST', '/credentials', alice, {
        instanceId: ids.instance,
        ownerUserId: ids.alice,
        label: 'mine',
        token: secret('Mine'),
      }),
    );
    const rows = (await s.rows()).filter((r) => r.kind === 'admin');
    const row = (action: string, targetId?: string) =>
      rows.find((r) => r.action === action && (targetId === undefined || r.targetId === targetId));
    expect(row('user.create', made.id)?.details).toMatchObject({ role: 'admin' });
    expect(row('user.update', made.id)?.details).toMatchObject({ role: 'owner', previousRole: 'admin' });
    expect(row('workspace.update', ids.teamB)?.details).toMatchObject({
      allowedScopeIds: '["Scope:2001","Scope:1001"]',
      enabledTools: `["whoami","${WRITE_TOOL}"]`,
      writePolicy: '{"enabled":true}',
      credentialSource: 'stored',
    });
    expect(row('token.issue', ids.aliceGrant)?.details).toMatchObject({
      tokenId: issued.record.id,
      tokenExpiresAt: null,
      expiresInDays: 'never',
    });
    expect(row('instance.create', instance.id)?.details).toMatchObject({
      host: 'elsewhere.example.test:8443',
    });
    expect(row('instance.retarget', instance.id)?.details).toMatchObject({
      host: 'moved.example.test',
      previousHost: 'elsewhere.example.test:8443',
    });
    expect(row('credential.create', personal.id)?.details).toMatchObject({
      instanceId: ids.instance,
      ownerUserId: ids.alice,
    });
    // Never a token, a name, an email or a path.
    const dump = JSON.stringify(rows);
    for (const forbidden of [issued.token, '/Main', 'new@example.test', 'laptop 2', 'Elsewhere']) {
      expect(dump, forbidden).not.toContain(forbidden);
    }
  });
});

describe('the admin API does not buffer a body past its cap', () => {
  it('fix: a member streaming megabytes is cut off near 64 KiB and answered 413', async () => {
    const { s, alice, ids } = await env();
    const chunk = new Uint8Array(16 * 1024).fill(0x20);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 400 * chunk.byteLength) controller.close();
        else {
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        }
      },
    });
    const res = await s.w.app.fetch(
      new Request(`${s.publicUrl}/api/admin/v1/me/grants/${ids.aliceGrant}/credential`, {
        method: 'POST',
        headers: {
          host: s.host,
          cookie: alice.cookie,
          'x-csrf-token': alice.csrf,
          origin: s.publicUrl,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        body: stream,
        // @ts-expect-error: Node's fetch needs this for a streamed request body.
        duplex: 'half',
      }),
    );
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(256 * 1024);
  });
});

describe('what holds', () => {
  it('mass assignment: fields a route does not name are refused, and nothing changes', async () => {
    const { s, owner, ids } = await env();
    const before = await snapshot(s);
    const cases: Array<[string, string, unknown]> = [
      ['PATCH', `/workspaces/${ids.teamA}`, { instanceId: ids.instance }],
      ['PATCH', `/workspaces/${ids.teamA}`, { id: 'wsp_x', createdAt: 1 }],
      ['PATCH', `/grants/${ids.aliceGrant}`, { userId: ids.owner }],
      ['PATCH', `/grants/${ids.aliceGrant}`, { revokedAt: null, workspaceId: ids.teamB }],
      ['PATCH', `/users/${ids.alice}`, { disabledAt: null, idp: 'x', idpSubject: 'y' }],
      ['PATCH', `/users/${ids.alice}`, JSON.parse('{"role":"member","__proto__":{"role":"owner"}}')],
      [
        'PATCH',
        `/instances/${ids.instance}`,
        { baseUrl: 'https://evil.example.test/x', tls: { caFile: '/x' } },
      ],
      ['POST', '/users', { email: 'x@example.test', role: 'member', idp: 'x', idpSubject: 'y' }],
      [
        'POST',
        '/credentials',
        { instanceId: ids.instance, ownerUserId: null, label: 'x', token: secret('X'), revokedAt: 1 },
      ],
      ['POST', `/grants/${ids.aliceGrant}/tokens`, { label: 'x', tokenHash: 'a'.repeat(64) }],
      ['POST', `/users/${ids.alice}/unbind`, { confirm: ALICE, force: true }],
    ];
    for (const [method, path, body] of cases) {
      const res = await s.api(method, path, owner, body);
      expect(res.status, `${method} ${path}`).toBe(422);
    }
    expect(await snapshot(s)).toBe(before);
  });

  it("a disabled user's cookie, device token and forms all stop at once, and enabling revives none of the cookies", async () => {
    const { s, owner, alice, ids } = await env();
    const mcp = (token: string) =>
      post(s.w, 'team-a', token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect((await mcp(s.w.tokens.alice)).status).toBe(200);
    expect((await s.api('POST', `/users/${ids.alice}/disable`, owner)).status).toBe(200);
    expect((await s.api('GET', '/session', alice)).status).toBe(401);
    expect((await s.api('POST', `/grants/${ids.aliceGrant}/tokens`, alice, { label: 'x' })).status).toBe(401);
    const form = await s.send('POST', '/admin/me/credentials', {
      cookie: alice.cookie,
      form: new URLSearchParams({
        _csrf: alice.csrf,
        instanceId: ids.instance,
        label: 'x',
        token: secret('X'),
      }).toString(),
    });
    expect(form.status).toBe(303);
    expect(form.headers.get('location')).toContain('/auth/login');
    expect((await mcp(s.w.tokens.alice)).status).toBe(401);
    expect(await s.w.storage.kv.list('sess:usr')).not.toContainEqual(expect.stringContaining(ids.alice));
    expect((await s.api('POST', `/users/${ids.alice}/enable`, owner)).status).toBe(200);
    expect((await s.api('GET', '/session', alice)).status).toBe(401);
    expect((await mcp(s.w.tokens.alice)).status).toBe(200);
  });

  it('a device token is no admin credential: not as a bearer, not beside a valid cookie, not on the panel', async () => {
    const { s, alice, ids } = await env();
    const bearer = { authorization: `Bearer ${s.w.tokens.alice}` };
    const before = await snapshot(s);
    for (const [method, path, body] of [
      ['GET', '/users', undefined],
      ['POST', `/grants/${ids.aliceGrant}/tokens`, { label: 'x' }],
      ['POST', '/users', { email: 'x@example.test', role: 'member' }],
    ] as const) {
      const alone = await s.send(method, `/api/admin/v1${path}`, {
        headers: bearer,
        ...(body === undefined ? {} : { body }),
      });
      expect(alone.status, `${method} ${path} with only the token`).toBe(401);
      // A bad bearer never falls back to a valid cookie (the browser session of the same person).
      const both = await s.api(method, path, alice, body, bearer);
      expect(both.status, `${method} ${path} with the token and a valid cookie`).toBe(401);
    }
    const panel = await s.send('GET', '/admin/me', { headers: bearer, site: 'none' });
    expect(panel.status).toBe(303);
    expect(panel.headers.get('location')).toContain('/auth/login');
    expect(await snapshot(s)).toBe(before);
  });

  it("id confusion: another person's credential, grant or token answers like a missing one and changes nothing", async () => {
    const { s, alice, ids } = await env();
    const before = await snapshot(s);
    const bobGrant = (await s.w.storage.grants.list({ userId: ids.bob }))[0]?.id as string;
    const bobToken = (await s.w.storage.accessTokens.list({ grantId: bobGrant }))[0]?.id as string;
    const attempts: Array<[string, string, unknown?]> = [
      ['POST', `/credentials/${ids.bobCredential}/revoke`],
      ['POST', `/credentials/${ids.bobCredential}/token`, { token: secret('Y') }],
      ['PATCH', `/credentials/${ids.bobCredential}`, { label: 'mine now' }],
      ['DELETE', `/credentials/${ids.bobCredential}`],
      ['POST', `/grants/${bobGrant}/tokens`, { label: 'x' }],
      ['GET', `/grants/${bobGrant}/tokens`],
      ['POST', `/tokens/${bobToken}/revoke`],
      ['POST', `/me/grants/${bobGrant}/credential`, { credentialId: ids.aliceCredential }],
      ['POST', `/me/grants/${ids.aliceGrant}/credential`, { credentialId: ids.bobCredential }],
    ];
    const missing = [
      ['POST', '/credentials/crd_none/revoke'],
      ['POST', '/tokens/tok_none/revoke'],
    ] as const;
    const bodies = new Set<string>();
    for (const [method, path, body] of attempts) {
      const res = await s.api(method, path, alice, body);
      expect([403, 404], `${method} ${path}`).toContain(res.status);
      if (res.status === 404 && path.includes('/credentials/') && path.endsWith('/revoke')) {
        bodies.add(JSON.stringify(await json(res)));
      }
    }
    const gone = await s.api(missing[0][0], missing[0][1], alice);
    expect(gone.status).toBe(404);
    expect(
      [...bodies].every(
        (b) => b === JSON.stringify({ error: { code: 'not_found', message: 'No credential with this id.' } }),
      ),
    ).toBe(true);
    expect(await snapshot(s)).toBe(before);
  });

  it('a stale session cannot take any step the guards ask a recent sign-in for', async () => {
    const { s, owner, admin, ids } = await env();
    const shared = (
      await json(
        await s.api('POST', '/credentials', owner, {
          instanceId: ids.instance,
          ownerUserId: null,
          label: 'team',
          token: secret('Team'),
        }),
      )
    ).id as string;
    s.w.now.t += 11 * MIN;
    const before = await snapshot(s);
    const attempts: Array<[string, string, unknown?]> = [
      ['POST', '/users', { email: 'o2@example.test', role: 'owner' }],
      ['PATCH', `/users/${ids.alice}`, { role: 'admin' }],
      ['POST', `/users/${ids.alice}/unbind`, { confirm: ALICE }],
      ['POST', `/instances/${ids.instance}/retarget`, { baseUrl: 'https://moved.example.test/x' }],
      ['POST', `/credentials/${shared}/token`, { token: secret('Z') }],
      ['POST', '/setup-links', {}],
      ['POST', '/keys/1/retire', { reason: 'test' }],
      ['PATCH', `/workspaces/${ids.teamA}`, { writePolicy: { enabled: true } }],
      ['PATCH', `/workspaces/${ids.teamA}`, { enabledTools: ['whoami', WRITE_TOOL] }],
      ['POST', '/grants', { workspaceId: ids.teamA, userId: ids.alice, tools: [WRITE_TOOL] }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await s.api(method, path, owner, body);
      expect([403, 409, 422], `${method} ${path}`).toContain(res.status);
      if (res.status === 403)
        expect((await json(res)).error.code, `${method} ${path}`).toBe('reauth_required');
    }
    for (const [method, path, body] of attempts.slice(0, 3)) {
      expect((await s.api(method, path, admin, body)).status, `${method} ${path} as admin`).toBe(403);
    }
    expect(await snapshot(s)).toBe(before);
  });
});
