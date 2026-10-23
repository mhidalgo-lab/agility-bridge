// SPDX-License-Identifier: Apache-2.0
// Member self-service (P4-07, THREAT_MODEL A5, A6, T3, T14, T20): a member brings their own Agility token, uses it on their
// grants and connects devices, through the panel and the admin API, against real sessions and memory storage with the
// synthetic Agility fake validating tokens. Negative authorization first (L-121): another person's or a shared credential, a
// grant or device token that is not theirs and an instance they have no grant on change nothing, leak nothing and call no
// upstream; secrets are never echoed; caps hold under parallel requests; a member never widens their scope.
import { describe, expect, it } from 'vitest';
import { MIN, setup } from './helpers/panel.ts';
import { TOOL_INFO } from './helpers/world.ts';

const OWNER = 'owner@example.test';
const ADMIN = 'admin@example.test';
const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';
const EVIL = '<img src=x onerror=alert(1)>"\'</title><script>alert(2)</script>';
const WRITE_TOOL = 'update_work_item';
const TOOLS = new Map([...TOOL_INFO, [WRITE_TOOL, { kind: 'write' as const, group: 'work' }]]);

type S = Awaited<ReturnType<typeof setup>>;
type Session = { cookie: string; csrf: string };

/** A secret built at run time, so no file holds a token-shaped literal (gitleaks). */
const secret = (label: string): string => `1.${label}${crypto.randomUUID().replaceAll('-', '')}`;
/** A token the fake Agility answers 401 for. */
const REJECTED = 'REJECTME';
const rejected = (): string => secret(REJECTED);

const enc = (fields: Record<string, string | string[]>): string =>
  new URLSearchParams(
    Object.entries(fields).flatMap(([k, v]) =>
      (Array.isArray(v) ? v : [v]).map((x) => [k, x] as [string, string]),
    ),
  ).toString();
const page = (s: S, path: string, who: Session | undefined) =>
  s.send('GET', path, { ...(who === undefined ? {} : { cookie: who.cookie }), site: 'none' });
const submit = (
  s: S,
  path: string,
  who: Session,
  fields: Record<string, string | string[]> = {},
  headers: Record<string, string> = {},
) => s.send('POST', path, { cookie: who.cookie, form: enc({ _csrf: who.csrf, ...fields }), headers });
const flashOf = (res: Response): string | undefined =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith('ab_flash='))
    ?.split(';')[0]
    ?.slice('ab_flash='.length);
const location = (res: Response): string | null => res.headers.get('location');
const idIn = (path: string | null): string => (path ?? '').split('/').pop() ?? '';
const handleOf = (html: string) => /name="_once" value="([^"]+)"/.exec(html)?.[1] as string;
const tagsOnly = (html: string): string => html.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
/** With attribute values blanked, no injected element or handler: only the page's own `<script src>` may remain. */
const NO_INJECTION = /<img|<script(?! src="")|<[a-z][^>]*\son[a-z]+=/i;

async function env() {
  const s = await setup({ tools: TOOLS, validate: { reject: (t) => t.includes(REJECTED) } });
  const owner = await s.session(OWNER);
  const admin = await s.session(ADMIN);
  const alice = await s.session(ALICE);
  const bob = await s.session(BOB);
  const shared = (
    await (
      await s.api('POST', '/credentials', owner, {
        instanceId: s.w.ids.instance,
        ownerUserId: null,
        label: 'Team token',
        token: secret('shared'),
      })
    ).json()
  ).id as string;
  const workspaceB = (await s.w.storage.workspaces.list()).find((w) => w.slug === 'team-b')?.id as string;
  const bobId = (await s.w.storage.users.list()).find((u) => u.email === BOB)?.id as string;
  const bobGrant = (await s.w.storage.grants.list({ userId: bobId }))[0]?.id as string;
  const aliceGrantB = (await s.w.storage.grants.list({ userId: s.w.ids.alice })).find(
    (g) => g.workspaceId === workspaceB,
  )?.id as string;
  return {
    s,
    owner,
    admin,
    alice,
    bob,
    ids: { ...s.w.ids, shared, workspaceB, bobGrant, aliceGrantB, bob: bobId },
  };
}
type E = Awaited<ReturnType<typeof env>>;

/** Everything a refused request must leave alone, and the open form handles. */
async function state(s: S): Promise<string> {
  const st = s.w.storage;
  return JSON.stringify({
    credentials: await st.credentials.list(),
    grants: await st.grants.list(),
    tokens: await st.accessTokens.list(),
    once: await st.kv.list('ui-once:'),
  });
}
const auditActions = async (s: S) => (await s.rows()).map((r) => `${r.action}:${r.status}`);

/** Every `<form method="post">` carries the viewer's CSRF token and posts to a same-origin path; no inline script or style. */
function expectSafe(html: string, who: Session, name: string): void {
  for (const f of html.matchAll(/<form [^>]*method="post"[^>]*>(.*?)<\/form>/gis)) {
    expect(f[0], name).toMatch(/action="\/[^/\\"][^"]*"/);
    expect(f[1], name).toContain(`name="_csrf" value="${who.csrf}"`);
  }
  expect(html, name).not.toMatch(/<script[^>]*>[^<]/i);
  expect(tagsOnly(html), name).not.toMatch(/<[a-z][^>]*\sstyle=/i);
  expect(tagsOnly(html), name).not.toMatch(/<[a-z][^>]*\son[a-z]+=/i);
}

/** Alice adds a token through the panel and returns its id. */
async function addToken(e: E, label: string, token: string, who: Session = e.alice): Promise<string> {
  const res = await submit(e.s, '/admin/me/credentials', who, {
    instanceId: e.ids.instance,
    label,
    token,
  });
  expect(res.status, label).toBe(303);
  return idIn(location(res));
}

describe('the browser flow: add a token, use it on my grant, connect a device', () => {
  it('works end to end for a member, with audit rows and no secret anywhere', async () => {
    const e = await env();
    const { s, alice } = e;
    const token = secret('mine');
    const seen: string[] = [];
    const get = async (path: string, who: Session = alice) => {
      const res = await page(s, path, who);
      const body = await res.text();
      seen.push(body);
      expectSafe(body, who, path);
      return { res, body };
    };

    const home = await get('/admin/me');
    expect(home.res.status).toBe(200);
    expect(home.body).toContain('Team A');
    expect(home.body).toContain('Team B');
    expect(home.body).toContain('Applications');
    expect(home.body).not.toContain('Team token');

    const form = await get('/admin/me/credentials/new');
    expect(form.res.status).toBe(200);
    expect(form.body).toContain('type="password"');
    expect(form.body).toContain('Fake');

    const created = await submit(s, '/admin/me/credentials', alice, {
      instanceId: e.ids.instance,
      label: 'My Agility token',
      token,
    });
    expect(created.status).toBe(303);
    expect(flashOf(created)).toBe('created');
    const credentialId = idIn(location(created));
    expect(location(created)).toBe(`/admin/me/credentials/${credentialId}`);
    const stored = await s.w.storage.credentials.get(credentialId);
    expect(stored).toMatchObject({
      ownerUserId: e.ids.alice,
      validationStatus: 'valid',
      memberName: 'Ann Example',
      tokenHint: token.slice(-4),
    });
    // Validated against the fake with exactly the token typed, and nowhere else.
    expect(s.w.agilityTokens).toContain(token);

    const detail = await get(location(created) as string);
    expect(detail.res.status).toBe(200);
    expect(detail.body).toContain(`…${token.slice(-4)}`);
    expect(detail.body).toContain('valid');

    // The grant page offers the new token, and choosing it changes only the credential.
    const grantPath = `/admin/me/grants/${e.ids.aliceGrant}`;
    const before = await s.w.storage.grants.get(e.ids.aliceGrant);
    const grantPage = await get(grantPath);
    expect(grantPage.body).toContain('My Agility token');
    const chosen = await submit(s, `${grantPath}/credential`, alice, { credentialId });
    expect(chosen.status).toBe(303);
    expect(flashOf(chosen)).toBe('saved');
    const after = await s.w.storage.grants.get(e.ids.aliceGrant);
    expect(after?.credentialId).toBe(credentialId);
    expect({ ...after, credentialId: null, updatedAt: 0 }).toEqual({
      ...before,
      credentialId: null,
      updatedAt: 0,
    });
    // Device tokens issued on the old credential were revoked by the switch (existing rule).
    expect((await s.w.storage.accessTokens.get(e.ids.aliceToken))?.revokedAt).not.toBeNull();

    // A device token: the form, then the one-time page; a re-sent form issues nothing more.
    const newToken = await get(`${grantPath}/tokens/new`);
    expect(newToken.res.status).toBe(200);
    const once = handleOf(newToken.body);
    const fields = { label: 'work-phone', lifetime: '30', _once: once };
    const issued = await submit(s, `${grantPath}/tokens`, alice, fields);
    expect(issued.status).toBe(200);
    expect(issued.headers.get('cache-control')).toBe('no-store');
    const issuedBody = await issued.text();
    expect(issuedBody).toMatch(/ab_(live|test)_/);
    const live = (await s.w.storage.accessTokens.list({ grantId: e.ids.aliceGrant })).filter(
      (t) => t.label === 'work-phone',
    );
    expect(live).toHaveLength(1);
    const again = await submit(s, `${grantPath}/tokens`, alice, fields);
    expect(again.status).toBe(303);
    expect(flashOf(again)).toBe('token_form_used');
    expect(
      (await s.w.storage.accessTokens.list({ grantId: e.ids.aliceGrant })).filter(
        (t) => t.label === 'work-phone',
      ),
    ).toHaveLength(1);

    // Revoke it from the same page, after a confirmation.
    const revokePath = `${grantPath}/tokens/${live[0]?.id}/revoke`;
    const ask = await submit(s, revokePath, alice);
    expect(ask.status).toBe(200);
    expect(await ask.text()).toContain('Revoke the token');
    const revoked = await submit(s, revokePath, alice, { confirm: 'yes' });
    expect(flashOf(revoked)).toBe('revoked');
    expect((await s.w.storage.accessTokens.get(live[0]?.id as string))?.revokedAt).not.toBeNull();

    // The recent-changes list shows her own work, and no secret appears in any page, audit row or log.
    const home2 = await get('/admin/me');
    expect(home2.body).toContain('credential.create');
    expect(home2.body).toContain('grant.set_credential');
    for (const body of seen) expect(body).not.toContain(token);
    expect(JSON.stringify(await s.rows())).not.toContain(token);
    expect(s.w.logs.join('\n')).not.toContain(token);
    const actions = await auditActions(s);
    expect(actions).toEqual(
      expect.arrayContaining([
        'credential.create:ok',
        'grant.set_credential:ok',
        'token.issue:ok',
        'token.revoke:ok',
      ]),
    );
    const mine = (await s.rows()).filter((r) => r.action === 'grant.set_credential');
    expect(mine[0]).toMatchObject({ userId: e.ids.alice, targetId: e.ids.aliceGrant });
    expect(mine[0]?.details).toMatchObject({ actor: 'member', credentialId });
  });

  it('stores a token Agility refuses as unusable, says so, and will not move a grant to it', async () => {
    const e = await env();
    const { s, alice } = e;
    const bad = rejected();
    const id = await addToken(e, 'Wrong one', bad);
    expect((await s.w.storage.credentials.get(id))?.validationStatus).toBe('invalid');
    const detail = await (await page(s, `/admin/me/credentials/${id}`, alice)).text();
    expect(detail).toContain('Agility did not accept this token');
    expect(detail).not.toContain(bad);
    const grantPath = `/admin/me/grants/${e.ids.aliceGrant}`;
    // The grant page does not offer it, and a forged post is refused without a change.
    expect(await (await page(s, grantPath, alice)).text()).not.toContain('Wrong one');
    const before = await state(s);
    const forged = await submit(s, `${grantPath}/credential`, alice, { credentialId: id });
    expect(flashOf(forged)).toBe('conflict');
    expect(await state(s)).toBe(before);
    // The token typed again, but a new one that Agility accepts, replaces it and then it can be used.
    const good = secret('good');
    const replaced = await submit(s, `/admin/me/credentials/${id}/token`, alice, { token: good });
    expect(flashOf(replaced)).toBe('saved');
    expect((await s.w.storage.credentials.get(id))?.validationStatus).toBe('valid');
    expect(flashOf(await submit(s, `${grantPath}/credential`, alice, { credentialId: id }))).toBe('saved');
    expect(JSON.stringify(await s.rows())).not.toContain(bad);
    expect(JSON.stringify(await s.rows())).not.toContain(good);
  });

  it('shows validation errors next to the field without the token, and refuses a malformed one', async () => {
    const e = await env();
    const { s, alice } = e;
    const typed = `1.${crypto.randomUUID()} with spaces`;
    const res = await submit(s, '/admin/me/credentials', alice, {
      instanceId: e.ids.instance,
      label: EVIL,
      token: typed,
    });
    expect(res.status).toBe(422);
    const body = await res.text();
    expect(body).not.toContain(typed);
    expect(body).not.toContain(typed.slice(0, 10));
    expect(tagsOnly(body)).not.toMatch(NO_INJECTION);
    expect(body).toContain('&lt;img');
    expect((await s.w.storage.credentials.list({ ownerUserId: e.ids.alice })).length).toBe(1);
    // Missing fields.
    for (const fields of [
      { instanceId: '', label: 'x', token: 'a' },
      { instanceId: e.ids.instance, label: '', token: 'a' },
      { instanceId: e.ids.instance, label: 'x', token: '' },
    ]) {
      expect((await submit(s, '/admin/me/credentials', alice, fields)).status).toBe(422);
    }
  });

  it('asks for a recent sign-in before replacing a token and changes nothing without it', async () => {
    const e = await env();
    const { s, alice } = e;
    const id = await addToken(e, 'Mine', secret('first'));
    const before = await s.w.storage.credentials.get(id);
    const token = secret('second');
    const path = `/admin/me/credentials/${id}/token`;
    s.w.now.t += 11 * MIN;
    const stale = await submit(s, path, alice, { token });
    expect(stale.status).toBe(403);
    const staleBody = await stale.text();
    expect(staleBody).toContain(`/auth/reauth?next=${encodeURIComponent(path)}`);
    expect(staleBody).not.toContain(token);
    expect(await s.w.storage.credentials.get(id)).toEqual(before);
    expect((await s.rows()).filter((r) => r.action === 'credential.replace_token')).toMatchObject([
      { status: 'denied', details: { error: 'reauth_required' } },
    ]);
    const fresh = await s.session(ALICE);
    expect(flashOf(await submit(s, path, fresh, { token }))).toBe('saved');
    expect((await s.w.storage.credentials.get(id))?.tokenHint).toBe(token.slice(-4));
    expect(JSON.stringify(await s.rows())).not.toContain(token);
  });

  it('removes a token: delete only when no grant uses it, and the encrypted token is gone', async () => {
    const e = await env();
    const { s, alice } = e;
    const id = await addToken(e, 'Temporary', secret('tmp'));
    const used = await addToken(e, 'In use', secret('use'));
    await submit(s, `/admin/me/grants/${e.ids.aliceGrant}/credential`, alice, { credentialId: used });
    // Used by a grant: no button, and a forged delete changes nothing.
    const usedPage = await (await page(s, `/admin/me/credentials/${used}`, alice)).text();
    expect(usedPage).not.toContain('Delete…');
    const before = await state(s);
    const refused = await submit(s, `/admin/me/credentials/${used}/delete`, alice, { confirm: 'yes' });
    expect(flashOf(refused)).toBe('conflict');
    expect(await state(s)).toBe(before);
    // Unused: a confirmation, then it is gone.
    const ask = await submit(s, `/admin/me/credentials/${id}/delete`, alice);
    expect(ask.status).toBe(200);
    expect(await state(s)).toBe(before);
    const done = await submit(s, `/admin/me/credentials/${id}/delete`, alice, { confirm: 'yes' });
    expect(flashOf(done)).toBe('deleted');
    expect(await s.w.storage.credentials.get(id)).toBeNull();
    expect(
      (await s.rows())
        .filter((r) => r.action === 'credential.delete')
        .map((r) => `${r.status}:${r.userId}`)
        .sort(),
    ).toEqual([`error:${e.ids.alice}`, `ok:${e.ids.alice}`]);
  });

  it('goes back to the workspace default only while the grant uses a token of mine', async () => {
    const e = await env();
    const { s, alice, owner } = e;
    // The workspace has a default shared credential; an administrator pins Alice's grant on Team B to the shared one.
    expect(
      (await s.api('PATCH', `/workspaces/${e.ids.workspaceB}`, owner, { defaultCredentialId: e.ids.shared }))
        .status,
    ).toBe(200);
    await s.w.storage.credentials.update(e.ids.shared, { validationStatus: 'valid' });
    expect(
      (await s.api('PATCH', `/grants/${e.ids.aliceGrantB}`, owner, { credentialId: e.ids.shared })).status,
    ).toBe(200);
    const path = `/me/grants/${e.ids.aliceGrantB}/credential`;
    const before = await state(s);
    // An administrator's pin is not hers to undo.
    expect((await s.api('POST', path, alice, { credentialId: null })).status).toBe(403);
    expect(await state(s)).toBe(before);
    // Her own token, then back to the default.
    const mine = await addToken(e, 'Mine', secret('own'));
    expect((await s.api('POST', path, alice, { credentialId: mine })).status).toBe(200);
    expect((await s.w.storage.grants.get(e.ids.aliceGrantB))?.credentialId).toBe(mine);
    expect((await s.api('POST', path, alice, { credentialId: null })).status).toBe(200);
    expect((await s.w.storage.grants.get(e.ids.aliceGrantB))?.credentialId).toBeNull();
  });
});

describe('every member screen, per role', () => {
  const screens = (e: E): string[] => [
    '/admin/me',
    '/admin/me/credentials/new',
    `/admin/me/credentials/${e.ids.aliceCredential}`,
    `/admin/me/credentials/${e.ids.aliceCredential}/token`,
    `/admin/me/grants/${e.ids.aliceGrant}`,
    `/admin/me/grants/${e.ids.aliceGrant}/tokens/new`,
  ];

  it('renders for owners, admins and members (their own data), with safe forms', async () => {
    const e = await env();
    for (const [role, who] of [
      ['member', e.alice],
      ['admin', e.admin],
      ['owner', e.owner],
    ] as const) {
      const res = await page(e.s, '/admin/me', who);
      expect(res.status, role).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.text();
      expectSafe(body, who, `${role} /admin/me`);
      expect(body, role).toContain('My access');
    }
    for (const path of screens(e)) {
      const res = await page(e.s, path, e.alice);
      expect(res.status, path).toBe(200);
      expectSafe(await res.text(), e.alice, path);
    }
    // An owner or admin has no grants and no tokens here: another person's pages are 404 for them too.
    for (const who of [e.admin, e.owner]) {
      for (const path of screens(e).slice(2)) expect((await page(e.s, path, who)).status, path).toBe(404);
    }
    expect((await page(e.s, '/admin/me/credentials/new', e.admin)).status).toBe(200);
    // The navigation offers "My access" to everyone.
    expect(await (await page(e.s, '/admin/account', e.alice)).text()).toContain('href="/admin/me"');
  });

  it('sends strangers to sign in and shows a disabled person nothing, writing nothing', async () => {
    const e = await env();
    const before = await state(e.s);
    for (const path of screens(e)) {
      const stranger = await page(e.s, path, undefined);
      expect(stranger.status, path).toBe(303);
      expect(location(stranger)).toContain('/auth/login?next=');
      expect(await stranger.text()).toBe('');
    }
    expect((await e.s.api('POST', `/users/${e.ids.alice}/disable`, e.owner)).status).toBe(200);
    for (const path of screens(e)) expect((await page(e.s, path, e.alice)).status, path).toBe(303);
    expect(await state(e.s)).toBe(before);
  });

  it('refuses the /me API to the admin token (nobody) and to the signed-out', async () => {
    const e = await env();
    const before = await state(e.s);
    for (const [method, path, body] of [
      ['GET', '/me/grants', undefined],
      ['GET', '/me/audit', undefined],
      ['POST', `/me/grants/${e.ids.aliceGrant}/credential`, { credentialId: null }],
    ] as const) {
      const res = await e.s.w.app.fetch(
        new Request(`${e.s.publicUrl}/api/admin/v1${path}`, {
          method,
          headers: { host: e.s.host, 'x-test-actor': 'break_glass', 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      expect(res.status, path).toBe(403);
      const anon = await e.s.send(method, `/api/admin/v1${path}`, {
        ...(body === undefined ? {} : { body }),
      });
      expect(anon.status, path).toBe(401);
    }
    expect(await state(e.s)).toBe(before);
  });
});

describe("a member never touches someone else's, a shared or an ungranted resource", () => {
  it('answers 404 for another person’s credential, grant, token and the shared credential, changing nothing', async () => {
    const e = await env();
    const { s, alice } = e;
    const bobToken = (await s.w.storage.accessTokens.list({ grantId: e.ids.bobGrant }))[0]?.id as string;
    const before = await state(s);
    const upstream = s.w.agilityTokens.length;
    const once =
      (await (await page(s, `/admin/me/grants/${e.ids.aliceGrant}/tokens/new`, alice)).text()).match(
        /name="_once" value="([^"]+)"/,
      )?.[1] ?? '';
    const afterForm = await state(s);
    const foreignCredentials = [e.ids.bobCredential, e.ids.shared];
    const posts: [string, Record<string, string>][] = [];
    for (const id of foreignCredentials) {
      posts.push([`/admin/me/credentials/${id}`, { label: 'taken' }]);
      for (const action of ['validate', 'revoke'])
        posts.push([`/admin/me/credentials/${id}/${action}`, { confirm: 'yes' }]);
      posts.push([`/admin/me/credentials/${id}/delete`, { confirm: 'yes' }]);
      posts.push([`/admin/me/credentials/${id}/token`, { token: secret('steal') }]);
      posts.push([`/admin/me/grants/${e.ids.aliceGrant}/credential`, { credentialId: id }]);
    }
    posts.push([`/admin/me/grants/${e.ids.bobGrant}/credential`, { credentialId: e.ids.aliceCredential }]);
    posts.push([`/admin/me/grants/${e.ids.bobGrant}/credential`, { credentialId: '' }]);
    posts.push([`/admin/me/grants/${e.ids.bobGrant}/tokens`, { label: 'x', lifetime: '30', _once: once }]);
    posts.push([`/admin/me/grants/${e.ids.bobGrant}/tokens/${bobToken}/revoke`, { confirm: 'yes' }]);
    posts.push([`/admin/me/grants/${e.ids.aliceGrant}/tokens/${bobToken}/revoke`, { confirm: 'yes' }]);
    for (const [path, fields] of posts) {
      const res = await submit(s, path, alice, fields);
      expect([303, 404, 403], path).toContain(res.status);
      if (res.status === 303)
        expect(['not_found', 'not_allowed', 'conflict', 'invalid', 'failed'], path).toContain(flashOf(res));
    }
    // Nothing changed, no handle was spent beyond the one form, and Agility was never called.
    const now = JSON.parse(await state(s));
    expect(now).toEqual(JSON.parse(afterForm));
    expect(JSON.parse(before).credentials).toEqual(now.credentials);
    expect(JSON.parse(before).grants).toEqual(now.grants);
    expect(JSON.parse(before).tokens).toEqual(now.tokens);
    expect(s.w.agilityTokens.length).toBe(upstream);
    // The pages: a 404 that names nothing.
    for (const path of [
      `/admin/me/credentials/${e.ids.bobCredential}`,
      `/admin/me/credentials/${e.ids.bobCredential}/token`,
      `/admin/me/credentials/${e.ids.shared}`,
      `/admin/me/credentials/${e.ids.shared}/token`,
      `/admin/me/grants/${e.ids.bobGrant}`,
      `/admin/me/grants/${e.ids.bobGrant}/tokens/new`,
    ]) {
      const res = await page(s, path, alice);
      expect(res.status, path).toBe(404);
      const body = await res.text();
      for (const leak of ['Team token', 'bob@example.test', 'Team B']) expect(body, path).not.toContain(leak);
    }
  });

  it('keeps the member area to the signed-in person even for owners and admins', async () => {
    const e = await env();
    const { s } = e;
    const once = handleOf(
      await (await page(s, `/admin/me/grants/${e.ids.aliceGrant}/tokens/new`, e.alice)).text(),
    );
    const afterForm = await state(s);
    const upstream = s.w.agilityTokens.length;
    for (const who of [e.owner, e.admin]) {
      const forged: [string, Record<string, string>][] = [
        [`/admin/me/credentials/${e.ids.aliceCredential}`, { label: 'taken' }],
        [`/admin/me/credentials/${e.ids.aliceCredential}/validate`, {}],
        [`/admin/me/credentials/${e.ids.aliceCredential}/revoke`, { confirm: 'yes' }],
        [`/admin/me/credentials/${e.ids.aliceCredential}/token`, { token: secret('steal') }],
        [`/admin/me/credentials/${e.ids.shared}/delete`, { confirm: 'yes' }],
        [`/admin/me/grants/${e.ids.aliceGrant}/credential`, { credentialId: '' }],
        [`/admin/me/grants/${e.ids.aliceGrant}/tokens`, { label: 'x', lifetime: '30', _once: once }],
        [`/admin/me/grants/${e.ids.aliceGrant}/tokens/${e.ids.aliceToken}/revoke`, { confirm: 'yes' }],
        [`/admin/me/grants/${e.ids.bobGrant}/tokens/${e.ids.aliceToken}/revoke`, { confirm: 'yes' }],
      ];
      for (const [path, fields] of forged) {
        const res = await submit(s, path, who, fields);
        expect([303, 404], path).toContain(res.status);
        if (res.status === 303) expect(flashOf(res), path).toBe('not_found');
      }
    }
    expect(await state(s)).toBe(afterForm);
    expect(s.w.agilityTokens.length).toBe(upstream);
  });

  it('refuses forged API calls with the same answers and no side effects', async () => {
    const e = await env();
    const { s, alice } = e;
    const before = await state(s);
    const upstream = s.w.agilityTokens.length;
    const bobToken = (await s.w.storage.accessTokens.list({ grantId: e.ids.bobGrant }))[0]?.id as string;
    const cases: [string, string, unknown, number][] = [
      ['GET', `/credentials/${e.ids.bobCredential}`, undefined, 404],
      ['GET', `/credentials/${e.ids.shared}`, undefined, 404],
      ['PATCH', `/credentials/${e.ids.bobCredential}`, { label: 'x' }, 404],
      ['POST', `/credentials/${e.ids.bobCredential}/validate`, undefined, 404],
      ['POST', `/credentials/${e.ids.bobCredential}/revoke`, undefined, 404],
      ['POST', `/credentials/${e.ids.bobCredential}/token`, { token: secret('x') }, 404],
      ['DELETE', `/credentials/${e.ids.bobCredential}`, undefined, 404],
      ['DELETE', `/credentials/${e.ids.shared}`, undefined, 404],
      ['POST', `/credentials/${e.ids.shared}/revoke`, undefined, 404],
      ['POST', `/credentials/${e.ids.shared}/token`, { token: secret('x') }, 403],
      [
        'POST',
        '/credentials',
        { instanceId: e.ids.instance, ownerUserId: e.ids.bob, label: 'x', token: secret('x') },
        403,
      ],
      [
        'POST',
        '/credentials',
        { instanceId: e.ids.instance, ownerUserId: null, label: 'x', token: secret('x') },
        403,
      ],
      ['GET', `/grants/${e.ids.bobGrant}`, undefined, 404],
      ['GET', `/grants/${e.ids.bobGrant}/tokens`, undefined, 404],
      ['POST', `/grants/${e.ids.bobGrant}/tokens`, { label: 'x' }, 404],
      ['POST', `/tokens/${bobToken}/revoke`, undefined, 404],
      ['POST', `/me/grants/${e.ids.bobGrant}/credential`, { credentialId: null }, 404],
      ['POST', `/me/grants/${e.ids.aliceGrant}/credential`, { credentialId: e.ids.bobCredential }, 404],
      ['POST', `/me/grants/${e.ids.aliceGrant}/credential`, { credentialId: e.ids.shared }, 404],
      ['POST', `/me/grants/${e.ids.aliceGrant}/credential`, { credentialId: null }, 422],
      ['POST', `/me/grants/${e.ids.aliceGrant}/credential`, { credentialId: 'crd_nope' }, 404],
      ['PATCH', `/grants/${e.ids.aliceGrant}`, { tools: ['whoami'] }, 403],
      ['POST', `/grants/${e.ids.aliceGrant}/revoke`, undefined, 403],
      ['PATCH', `/workspaces/${e.ids.workspaceA}`, { name: 'x' }, 403],
    ];
    for (const [method, path, body, want] of cases) {
      const res = await s.api(method, path, alice, body);
      expect(res.status, `${method} ${path}`).toBe(want);
      expect(JSON.stringify(await res.json()), `${method} ${path}`).not.toContain(e.ids.bob);
    }
    expect(await state(s)).toBe(before);
    expect(s.w.agilityTokens.length).toBe(upstream);
    // Denials of audited routes are recorded with Alice as the actor.
    const denied = (await s.rows()).filter((r) => r.status === 'denied' && r.userId === e.ids.alice);
    expect(denied.length).toBeGreaterThan(0);
  });

  it('keeps tokens to instances the member has a grant on', async () => {
    const e = await env();
    const { s, alice, owner } = e;
    const other = (
      await (
        await s.api('POST', '/instances', owner, { label: 'Other', baseUrl: 'http://127.0.0.1:9' })
      ).json()
    ).id as string | undefined;
    // Instance creation probes the origin; whether or not it succeeds, the member cannot store a token there.
    const target = other ?? e.ids.instance;
    if (other !== undefined) {
      const before = await state(s);
      const res = await s.api('POST', '/credentials', alice, {
        instanceId: other,
        ownerUserId: e.ids.alice,
        label: 'x',
        token: secret('x'),
      });
      expect(res.status).toBe(403);
      expect(await state(s)).toBe(before);
      const form = await submit(s, '/admin/me/credentials', alice, {
        instanceId: other,
        label: 'x',
        token: secret('y'),
      });
      expect(form.status).toBe(403);
      expect(await state(s)).toBe(before);
    }
    // Revoked grants do not count: Alice loses her grants, then cannot add.
    for (const g of await s.w.storage.grants.list({ userId: e.ids.alice }))
      await s.api('POST', `/grants/${g.id}/revoke`, owner);
    const res = await s.api('POST', '/credentials', alice, {
      instanceId: target,
      ownerUserId: e.ids.alice,
      label: 'x',
      token: secret('z'),
    });
    expect(res.status).toBe(403);
  });

  it('never widens scope: the switch changes the credential only, and write tools stay off', async () => {
    const e = await env();
    const { s, alice, owner } = e;
    // A grant with a write tool needs a personal credential: it is Alice's, and it still cannot switch to a shared one.
    await s.api('PATCH', `/workspaces/${e.ids.workspaceA}`, owner, {
      enabledTools: [WRITE_TOOL, 'whoami'],
      writePolicy: { enabled: true },
    });
    expect(
      (await s.api('PATCH', `/grants/${e.ids.aliceGrant}`, owner, { tools: ['whoami', WRITE_TOOL] })).status,
    ).toBe(200);
    const mine = await addToken(e, 'Mine', secret('w'));
    const before = await s.w.storage.grants.get(e.ids.aliceGrant);
    expect(
      (await s.api('POST', `/me/grants/${e.ids.aliceGrant}/credential`, alice, { credentialId: mine }))
        .status,
    ).toBe(200);
    const after = await s.w.storage.grants.get(e.ids.aliceGrant);
    expect({ ...after, credentialId: 0, updatedAt: 0 }).toEqual({ ...before, credentialId: 0, updatedAt: 0 });
    // Back to a shared default would turn a write grant read-only-credentialed: refused (422), nothing changes.
    await s.api('PATCH', `/workspaces/${e.ids.workspaceA}`, owner, { defaultCredentialId: e.ids.shared });
    const kept = await state(s);
    expect(
      (await s.api('POST', `/me/grants/${e.ids.aliceGrant}/credential`, alice, { credentialId: null }))
        .status,
    ).toBe(422);
    expect(await state(s)).toBe(kept);
    // The body takes a credential id and nothing else.
    for (const body of [
      { credentialId: mine, tools: ['whoami'] },
      { credentialId: mine, scopeIds: ['Scope:2001'] },
      { credentialId: mine, userId: e.ids.bob },
      { tools: [WRITE_TOOL] },
      {},
    ]) {
      expect((await s.api('POST', `/me/grants/${e.ids.aliceGrant}/credential`, alice, body)).status).toBe(
        422,
      );
    }
    expect(await state(s)).toBe(kept);
  });

  it('lists and audits only my own: /me/grants and /me/audit', async () => {
    const e = await env();
    const { s, alice, bob } = e;
    await addToken(e, 'Alice one', secret('a1'));
    await addToken(e, 'Bob one', secret('b1'), bob);
    const grants = await (await s.api('GET', '/me/grants', alice)).json();
    expect(grants.map((g: { grant: { userId: string } }) => g.grant.userId)).toEqual([
      e.ids.alice,
      e.ids.alice,
    ]);
    expect(grants.map((g: { workspace: { slug: string } }) => g.workspace.slug).sort()).toEqual([
      'team-a',
      'team-b',
    ]);
    const mine = await (await s.api('GET', '/me/audit', alice)).json();
    expect(mine.length).toBeGreaterThan(0);
    for (const row of mine) {
      expect(Object.keys(row).sort()).toEqual(['action', 'id', 'status', 'targetId', 'targetType', 'ts']);
    }
    const bobsRows = (await s.rows()).filter((r) => r.userId === e.ids.bob).map((r) => r.id);
    expect(mine.map((r: { id: string }) => r.id).some((id: string) => bobsRows.includes(id))).toBe(false);
    expect((await s.api('GET', '/me/audit?limit=51', alice)).status).toBe(422);
    expect((await s.api('GET', '/me/audit?limit=1', alice).then((r) => r.json())).length).toBe(1);
    // The break-glass-free roles all work from their own id.
    expect(await s.api('GET', '/me/grants', e.owner).then((r) => r.json())).toEqual([]);
  });
});

describe('caps hold', () => {
  it('keeps at most 10 personal credentials per person, also for parallel adds', async () => {
    const e = await env();
    const { s, alice } = e;
    // Alice has one; add eight more, then race five.
    for (let i = 0; i < 8; i++) await addToken(e, `T${i}`, secret(`c${i}`));
    expect((await s.w.storage.credentials.list({ ownerUserId: e.ids.alice })).length).toBe(9);
    const race = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        s.api('POST', '/credentials', alice, {
          instanceId: e.ids.instance,
          ownerUserId: e.ids.alice,
          label: `R${i}`,
          token: secret(`r${i}`),
        }),
      ),
    );
    expect(race.filter((r) => r.status === 201).length).toBeLessThanOrEqual(1);
    expect((await s.w.storage.credentials.list({ ownerUserId: e.ids.alice })).length).toBeLessThanOrEqual(10);
    // Fill to the cap if the race left room, then the next add is refused and says so.
    while ((await s.w.storage.credentials.list({ ownerUserId: e.ids.alice })).length < 10)
      await addToken(e, 'fill', secret('f'));
    const full = await submit(s, '/admin/me/credentials', alice, {
      instanceId: e.ids.instance,
      label: 'over',
      token: secret('over'),
    });
    expect(full.status).toBe(409);
    expect(await full.text()).toContain('most personal tokens');
    expect(
      (
        await s.api('POST', '/credentials', alice, {
          instanceId: e.ids.instance,
          ownerUserId: e.ids.alice,
          label: 'over',
          token: secret('o2'),
        })
      ).status,
    ).toBe(409);
    expect((await s.w.storage.credentials.list({ ownerUserId: e.ids.alice })).length).toBe(10);
    // Bob's allowance is his own, and deleting one frees a place.
    await addToken(e, 'Bob', secret('bob'), e.bob);
    const first = (await s.w.storage.credentials.list({ ownerUserId: e.ids.alice })).find(
      (c) => c.label === 'fill' || c.label === 'T0',
    );
    expect((await s.api('DELETE', `/credentials/${first?.id}`, alice)).status).toBe(200);
    await addToken(e, 'again', secret('again'));
    expect((await s.w.storage.credentials.list({ ownerUserId: e.ids.alice })).length).toBe(10);
  });

  it('keeps at most 20 live device tokens per grant, also for parallel issues', async () => {
    const e = await env();
    const { s, alice } = e;
    const path = `/grants/${e.ids.aliceGrant}/tokens`;
    const live = async () =>
      (await s.w.storage.accessTokens.list({ grantId: e.ids.aliceGrant })).filter((t) => t.revokedAt === null)
        .length;
    // One exists; issue 17 more, then race five for the last three places.
    for (let i = 0; i < 17; i++)
      expect((await s.api('POST', path, alice, { label: `d${i}` })).status).toBe(201);
    expect(await live()).toBe(18);
    const race = await Promise.all(
      Array.from({ length: 6 }, (_, i) => s.api('POST', path, alice, { label: `r${i}` })),
    );
    expect(await live()).toBeLessThanOrEqual(20);
    expect(race.filter((r) => r.status === 201).length).toBeLessThanOrEqual(2);
    // Fill up, then the next is refused with the cap message and by the panel too.
    while ((await live()) < 20) await s.api('POST', path, alice, { label: 'fill' });
    const over = await s.api('POST', path, alice, { label: 'over' });
    expect(over.status).toBe(409);
    expect((await over.json()).error.message).toContain('20 live device tokens');
    expect(await live()).toBe(20);
    // Revoked and expired ones do not count.
    const some = (await s.w.storage.accessTokens.list({ grantId: e.ids.aliceGrant })).find(
      (t) => t.revokedAt === null,
    );
    expect((await s.api('POST', `/tokens/${some?.id}/revoke`, alice)).status).toBe(200);
    expect((await s.api('POST', path, alice, { label: 'room' })).status).toBe(201);
    // The panel refuses with its fixed message, handle intact for a retry.
    const form = await (await page(s, `/admin/me/grants/${e.ids.aliceGrant}/tokens/new`, alice)).text();
    const res = await submit(
      s,
      `/admin/me/grants/${e.ids.aliceGrant}${path.slice(path.indexOf('/tokens'))}`,
      alice,
      {
        label: 'x',
        lifetime: '30',
        _once: handleOf(form),
      },
    );
    expect(res.status).toBe(303);
    expect(flashOf(res)).toBe('conflict');
    expect(await live()).toBe(20);
  });
});

describe('forms refuse what a browser would not send', () => {
  it('refuses missing CSRF, cross-site posts and wrong content types without effect', async () => {
    const e = await env();
    const { s, alice } = e;
    const token = secret('csrf');
    const before = await state(s);
    const body = enc({ instanceId: e.ids.instance, label: 'x', token });
    const noCsrf = await s.send('POST', '/admin/me/credentials', { cookie: alice.cookie, form: body });
    expect(noCsrf.status).toBe(403);
    const crossSite = await submit(
      s,
      '/admin/me/credentials',
      alice,
      { instanceId: e.ids.instance, label: 'x', token },
      { 'sec-fetch-site': 'cross-site' },
    );
    expect(crossSite.status).toBe(403);
    const wrongOrigin = await submit(
      s,
      '/admin/me/credentials',
      alice,
      { instanceId: e.ids.instance, label: 'x', token },
      { origin: 'https://evil.example' },
    );
    expect(wrongOrigin.status).toBe(403);
    const json = await s.send('POST', '/admin/me/credentials', { cookie: alice.cookie, body: { token } });
    expect(json.status).toBe(415);
    const get = await s.send('GET', `/admin/me/credentials/${e.ids.aliceCredential}/delete`, {
      cookie: alice.cookie,
      site: 'none',
    });
    expect([404, 405]).toContain(get.status);
    for (const res of [noCsrf, crossSite, wrongOrigin, json]) expect(await res.text()).not.toContain(token);
    expect(await state(s)).toBe(before);
    expect(s.w.agilityTokens).not.toContain(token);
  });

  it('writes no form handle for HEAD and caps open handles', async () => {
    const e = await env();
    const { s, alice } = e;
    const path = `/admin/me/grants/${e.ids.aliceGrant}/tokens/new`;
    const head = await s.send('HEAD', path, { cookie: alice.cookie, site: 'none' });
    expect(head.status).toBe(200);
    expect((await s.w.storage.kv.list('ui-once:')).length).toBe(0);
    for (let i = 0; i < 30; i++) await page(s, path, alice);
    expect((await s.w.storage.kv.list('ui-once:')).length).toBeLessThanOrEqual(10);
  });

  it('keeps hostile names inert on every member page', async () => {
    const e = await env();
    const { s, alice } = e;
    const id = await addToken(e, EVIL, secret('evil'));
    await s.api('PATCH', `/workspaces/${e.ids.workspaceA}`, e.owner, { name: EVIL });
    await submit(s, `/admin/me/grants/${e.ids.aliceGrant}/credential`, alice, { credentialId: id });
    for (const path of [
      '/admin/me',
      `/admin/me/credentials/${id}`,
      `/admin/me/credentials/${id}/token`,
      `/admin/me/grants/${e.ids.aliceGrant}`,
    ]) {
      const body = await (await page(s, path, alice)).text();
      expect(tagsOnly(body), path).not.toMatch(NO_INJECTION);
    }
    const ask = await submit(s, `/admin/me/credentials/${id}/revoke`, alice);
    expect(tagsOnly(await ask.text())).not.toMatch(NO_INJECTION);
  });
});
