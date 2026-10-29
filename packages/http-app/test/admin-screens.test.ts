// SPDX-License-Identifier: Apache-2.0
// The admin screens over HTTP (P4-04, THREAT_MODEL T3, T8, T13, T14, A5, A14): instances, credentials, workspaces, grants,
// device tokens and users, driven like a browser against real sessions, the real admin API and memory storage (the same
// storage contract as SQLite and D1). Role matrices, negative authorization (a refusal changes nothing and leaks nothing),
// CSRF and fetch-metadata refusals, re-authentication, the one-time token page, secrets never echoed, hostile strings inert,
// and "a panel change is an admin API change". No network.
import { describe, expect, it } from 'vitest';
import { MIN, setup } from './helpers/panel.ts';
import { post as mcpPost, TOOL_INFO } from './helpers/world.ts';

const OWNER = 'owner@example.test';
const ADMIN = 'admin@example.test';
const ALICE = 'alice@example.test';
const EVIL = '<img src=x onerror=alert(1)>"\'</title><script>alert(2)</script>';
/** A write tool the catalogue knows, so write settings and write grants can be exercised (core tools are read-only). */
const WRITE_TOOL = 'update_work_item';
const TOOLS = new Map([...TOOL_INFO, [WRITE_TOOL, { kind: 'write' as const, group: 'work' }]]);

type S = Awaited<ReturnType<typeof setup>>;
type Session = { cookie: string; csrf: string };

/** A secret built at run time, so no file holds a token-shaped literal (gitleaks). */
const secret = (label: string): string => `1.${label}${crypto.randomUUID().replaceAll('-', '')}`;

const enc = (fields: Record<string, string | string[]>): string =>
  new URLSearchParams(
    Object.entries(fields).flatMap(([k, v]) =>
      (Array.isArray(v) ? v : [v]).map((x) => [k, x] as [string, string]),
    ),
  ).toString();
const page = (s: S, path: string, who: Session | undefined, headers: Record<string, string> = {}) =>
  s.send('GET', path, { ...(who === undefined ? {} : { cookie: who.cookie }), site: 'none', headers });
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

async function env(options: Parameters<typeof setup>[0] = {}) {
  const s = await setup({ tools: TOOLS, ...options });
  const owner = await s.session(OWNER);
  const admin = await s.session(ADMIN);
  const alice = await s.session(ALICE);
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
  const wsB = (await s.w.storage.workspaces.list()).find((w) => w.slug === 'team-b');
  const ids = {
    ...s.w.ids,
    shared,
    workspaceB: wsB?.id as string,
    ownerCred: '',
  };
  await s.w.storage.credentials.update(shared, { validationStatus: 'valid' });
  // A service grant on the shared credential: device tokens can be issued on it by an owner or an admin.
  const svc = (
    await (
      await s.api('POST', '/grants', owner, {
        workspaceId: ids.workspaceA,
        userId: null,
        label: 'ci',
        credentialId: shared,
      })
    ).json()
  ).record.id as string;
  return { s, owner, admin, alice, ids: { ...ids, serviceGrant: svc } };
}
type E = Awaited<ReturnType<typeof env>>;

/** Everything a refused request must leave alone: every table the screens change, and the open form handles. */
async function state(s: S): Promise<string> {
  const st = s.w.storage;
  return JSON.stringify({
    users: await st.users.list(),
    instances: await st.instances.list(),
    credentials: await st.credentials.list(),
    workspaces: await st.workspaces.list(),
    grants: await st.grants.list(),
    tokens: await st.accessTokens.list(),
    once: await st.kv.list('ui-once:'),
  });
}
const auditActions = async (s: S) => (await s.rows()).map((r) => `${r.action}:${r.status}`);
const forbiddenReasons = async (s: S) =>
  (await s.rows())
    .filter((r) => r.action === 'admin.forbidden')
    .map((r) => (r.details as { reason?: string }).reason);

/** The page's markup with attribute values blanked: an escaped value may hold the text of a handler, a tag cannot. */
const tagsOnly = (html: string): string => html.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");

/** Every `<form method="post">` of a page carries the viewer's CSRF token and posts to a same-origin path. */
function expectSafeForms(html: string, who: Session, name: string): void {
  const forms = [...html.matchAll(/<form [^>]*method="post"[^>]*>(.*?)<\/form>/gis)];
  for (const f of forms) {
    expect(f[0], name).toMatch(/action="\/[^/\\"][^"]*"|action="\/"/);
    expect(f[1], name).toContain(`name="_csrf" value="${who.csrf}"`);
  }
  expect(html, name).not.toMatch(/<script[^>]*>[^<]/i);
  expect(tagsOnly(html), name).not.toMatch(/<[a-z][^>]*\sstyle=/i);
  expect(tagsOnly(html), name).not.toMatch(/<[a-z][^>]*\son[a-z]+=/i);
  expect(html, name).not.toMatch(/(?:href|action)="(?:https?:)?\/\//i);
}

describe('every screen renders for each role', () => {
  const screens = (e: E): string[] => [
    '/admin/instances',
    '/admin/instances/new',
    `/admin/instances/${e.ids.instance}`,
    '/admin/credentials',
    '/admin/credentials/new',
    `/admin/credentials/${e.ids.shared}`,
    `/admin/credentials/${e.ids.shared}/token`,
    `/admin/credentials/${e.ids.aliceCredential}`,
    '/admin/workspaces',
    '/admin/workspaces/new',
    `/admin/workspaces/new?instance=${e.ids.instance}`,
    `/admin/workspaces/${e.ids.workspaceA}`,
    `/admin/workspaces/${e.ids.workspaceA}/edit`,
    '/admin/tokens',
    `/admin/instances/${e.ids.instance}/prefixes`,
    '/admin/grants',
    `/admin/grants?workspace=${e.ids.workspaceA}`,
    '/admin/grants/new',
    `/admin/grants/new?workspace=${e.ids.workspaceA}`,
    `/admin/grants/${e.ids.aliceGrant}`,
    `/admin/grants/${e.ids.aliceGrant}/edit`,
    `/admin/grants/${e.ids.serviceGrant}/tokens/new`,
    '/admin/users',
    '/admin/users/new',
    `/admin/users/${e.ids.alice}`,
  ];

  it('shows owners and admins every screen, with safe forms and no inline script or style', async () => {
    const e = await env();
    for (const [role, who] of [
      ['owner', e.owner],
      ['admin', e.admin],
    ] as const) {
      for (const path of screens(e)) {
        const res = await page(e.s, path, who);
        expect(res.status, `${role} ${path}`).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expectSafeForms(await res.text(), who, `${role} ${path}`);
      }
    }
    // Everything above only read: no handle but the one token form wrote, and nothing else changed.
    expect((await e.s.w.storage.kv.list('ui-once:')).length).toBe(2);
  }, 30_000);

  it('shows members, strangers and disabled people nothing, and writes nothing', async () => {
    const e = await env();
    const before = await state(e.s);
    for (const path of screens(e)) {
      const member = await page(e.s, path, e.alice);
      expect(member.status, `member ${path}`).toBe(403);
      const body = await member.text();
      for (const leak of ['Team token', e.ids.shared, OWNER])
        expect(body, `member ${path} leaks ${leak}`).not.toContain(leak);
      const stranger = await page(e.s, path, undefined);
      expect(stranger.status, `stranger ${path}`).toBe(303);
      expect(location(stranger)).toContain('/auth/login?next=');
      expect(await stranger.text()).toBe('');
    }
    expect(await state(e.s)).toBe(before);
    // A disabled person loses the screens at once.
    expect((await e.s.api('POST', `/users/${e.ids.admin}/disable`, e.owner)).status).toBe(200);
    for (const path of screens(e).slice(0, 6)) expect((await page(e.s, path, e.admin)).status).toBe(303);
  });

  it('answers 404 for ids that do not exist, without asking for anything odd', async () => {
    const e = await env();
    for (const path of [
      '/admin/instances/ins_nope',
      '/admin/credentials/crd_nope',
      '/admin/workspaces/wsp_nope',
      '/admin/grants/grt_nope',
      '/admin/users/usr_nope',
      '/admin/grants/..%2fusers',
      `/admin/grants/${'a'.repeat(300)}`,
    ]) {
      const res = await page(e.s, path, e.owner);
      expect([404, 400], path).toContain(res.status);
      expect(await res.text(), path).not.toContain('Team token');
    }
  });
});

describe('hostile strings stay inert on every screen', () => {
  it('escapes names, labels and emails that carry markup', async () => {
    const e = await env();
    const { s, owner } = e;
    const evilEmail = '"><svg onload=alert(3)>@example.test';
    await s.api('PATCH', `/users/${e.ids.owner}`, owner, { displayName: EVIL });
    const u = await (
      await s.api('POST', '/users', owner, { email: evilEmail, role: 'member', displayName: EVIL })
    ).json();
    const inst = await (
      await s.api('POST', '/instances', owner, { label: EVIL, baseUrl: 'https://evil.example.test/x' })
    ).json();
    const cred = await (
      await s.api('POST', '/credentials', owner, {
        instanceId: inst.id,
        ownerUserId: null,
        label: EVIL,
        token: secret('hostile'),
      })
    ).json();
    const ws = await (
      await s.api('POST', '/workspaces', owner, {
        slug: 'evil',
        name: EVIL,
        instanceId: inst.id,
        allowedScopeIds: ['Scope:1'],
        defaultCredentialId: cred.id,
      })
    ).json();
    const grant = await (
      await s.api('POST', '/grants', owner, { workspaceId: ws.id, userId: null, label: EVIL })
    ).json();
    await s.api('POST', `/grants/${grant.record.id}/tokens`, owner, { label: EVIL });
    const paths = [
      '/admin',
      '/admin/instances',
      `/admin/instances/${inst.id}`,
      '/admin/credentials',
      `/admin/credentials/${cred.id}`,
      `/admin/credentials/${cred.id}/token`,
      '/admin/workspaces',
      `/admin/workspaces/${ws.id}`,
      `/admin/workspaces/${ws.id}/edit`,
      '/admin/grants',
      `/admin/grants/${grant.record.id}`,
      `/admin/grants/${grant.record.id}/edit`,
      `/admin/grants/${grant.record.id}/tokens/new`,
      `/admin/grants/new?workspace=${ws.id}`,
      '/admin/users',
      `/admin/users/${u.id}`,
      `/admin/workspaces/new?instance=${inst.id}`,
      '/admin/credentials/new',
    ];
    for (const path of paths) {
      const html = await (await page(s, path, owner)).text();
      expect(html, path).not.toContain('<img src=x');
      expect(html, path).not.toContain('<script>alert');
      expect(html, path).not.toContain('<svg onload');
      expect(html, path).not.toMatch(/<script[^>]*>[^<]/i);
      expect(tagsOnly(html), path).not.toMatch(/<[a-z][^>]*\son[a-z]+=/i);
    }
    // And somewhere they are shown, as text.
    const detail = await (await page(s, `/admin/instances/${inst.id}`, owner)).text();
    expect(detail).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(await (await page(s, '/admin/users', owner)).text()).toContain('&lt;svg onload=alert(3)&gt;');
    // Query values are inert too: a filter value is never reflected unescaped.
    const filtered = await (
      await page(s, `/admin/grants?workspace=${encodeURIComponent(EVIL)}`, owner)
    ).text();
    expect(filtered).not.toContain('<img src=x');
    // And a hostile value posted to a form comes back escaped.
    const bad = await submit(s, '/admin/instances', owner, { label: EVIL, baseUrl: 'not a url' });
    expect(bad.status).toBe(422);
    const badHtml = await bad.text();
    expect(badHtml).not.toContain('<img src=x');
    expect(badHtml).toContain('&lt;img src=x');
  });
});

describe('instances', () => {
  it('adds, renames, disables, enables and deletes an instance as an admin, through the admin API', async () => {
    const e = await env();
    const { s, admin } = e;
    const created = await submit(s, '/admin/instances', admin, {
      label: 'Staging',
      baseUrl: 'https://stg.example.test/acme',
    });
    expect(created.status).toBe(303);
    expect(flashOf(created)).toBe('created');
    const id = idIn(location(created));
    expect(await s.w.storage.instances.get(id)).toMatchObject({
      label: 'Staging',
      baseUrl: 'https://stg.example.test/acme',
    });
    expect((await submit(s, `/admin/instances/${id}`, admin, { label: 'Staging 2' })).status).toBe(303);
    expect((await s.w.storage.instances.get(id))?.label).toBe('Staging 2');
    // Disabling asks first.
    const ask = await submit(s, `/admin/instances/${id}/disable`, admin);
    expect(ask.status).toBe(200);
    expect(await ask.text()).toContain('Disable Staging 2?');
    expect((await s.w.storage.instances.get(id))?.disabledAt).toBeNull();
    expect(flashOf(await submit(s, `/admin/instances/${id}/disable`, admin, { confirm: 'yes' }))).toBe(
      'disabled',
    );
    expect((await s.w.storage.instances.get(id))?.disabledAt).toBe(s.w.now.t);
    expect(flashOf(await submit(s, `/admin/instances/${id}/enable`, admin))).toBe('enabled');
    expect((await s.w.storage.instances.get(id))?.disabledAt).toBeNull();
    const del = await submit(s, `/admin/instances/${id}/delete`, admin);
    expect(await del.text()).toContain('Delete Staging 2?');
    expect(await s.w.storage.instances.get(id)).not.toBeNull();
    expect(flashOf(await submit(s, `/admin/instances/${id}/delete`, admin, { confirm: 'yes' }))).toBe(
      'deleted',
    );
    expect(await s.w.storage.instances.get(id)).toBeNull();
    // One in use cannot be deleted: a fixed message, nothing changed.
    const used = await submit(s, `/admin/instances/${e.ids.instance}/delete`, admin, { confirm: 'yes' });
    expect(flashOf(used)).toBe('conflict');
    expect(await s.w.storage.instances.get(e.ids.instance)).not.toBeNull();
  });

  it('shows the field message of an invalid address and keeps what was typed', async () => {
    const e = await env();
    const res = await submit(e.s, '/admin/instances', e.admin, {
      label: 'Typed label',
      baseUrl: 'ftp://nope',
    });
    const html = await res.text();
    expect(res.status).toBe(422);
    expect(html).toContain('value="Typed label"');
    expect(html).toContain('class="error"');
    expect((await e.s.w.storage.instances.list()).some((i) => i.label === 'Typed label')).toBe(false);
  });

  it('keeps origin and certificate-authority changes to owners with a recent sign-in, and says what is revoked', async () => {
    const e = await env();
    const { s, owner, admin, alice } = e;
    const path = `/admin/instances/${e.ids.instance}/origin`;
    const fields = { baseUrl: 'https://moved.example.test/acme', understood: '1' };
    // The button exists for owners only; the form is a 403 for everyone else and changes nothing.
    expect(await (await page(s, `/admin/instances/${e.ids.instance}`, owner)).text()).toContain(
      'Change the origin…',
    );
    const adminDetail = await (await page(s, `/admin/instances/${e.ids.instance}`, admin)).text();
    expect(adminDetail).not.toContain('Change the origin…');
    expect(adminDetail).toContain('Only an owner can change');
    const before = await state(s);
    expect((await page(s, path, admin)).status).toBe(403);
    expect((await page(s, path, alice)).status).toBe(403);
    expect((await submit(s, path, admin, fields)).status).toBe(403);
    expect((await submit(s, path, alice, fields)).status).toBe(403);
    expect(await state(s)).toBe(before);
    // The API refuses an admin too (no upstream call, no data): the panel is not the only guard.
    expect(
      (await s.api('POST', `/instances/${e.ids.instance}/retarget`, admin, { baseUrl: fields.baseUrl }))
        .status,
    ).toBe(403);
    expect(await state(s)).toBe(before);
    // The page names the consequence.
    const form = await (await page(s, path, owner)).text();
    expect(form).toContain('revokes every credential');
    expect(form).toContain('understood');
    // Without the box ticked: nothing changes.
    const unticked = await submit(s, path, owner, { baseUrl: fields.baseUrl });
    expect(unticked.status).toBe(422);
    expect(await state(s)).toBe(before);
    // A stale sign-in: the page asks for a new one, and nothing changed.
    s.w.now.t += 11 * MIN;
    const stale = await submit(s, path, owner, fields);
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain(`/auth/reauth?next=${encodeURIComponent(path)}`);
    expect(await state(s)).toBe(before);
    expect(
      (await s.rows()).filter(
        (r) => r.action === 'instance.retarget' && (r.details as { actor?: string }).actor === 'owner',
      ),
    ).toMatchObject([{ status: 'denied', details: { error: 'reauth_required' } }]);
  });

  it('retargets for an owner who signed in recently: credentials and grants are revoked, and the flash says so', async () => {
    const e = await env();
    const { s, owner } = e;
    const res = await submit(s, `/admin/instances/${e.ids.instance}/origin`, owner, {
      baseUrl: 'https://moved.example.test/acme',
      understood: '1',
    });
    expect(res.status).toBe(303);
    expect(flashOf(res)).toBe('origin_changed');
    expect((await s.w.storage.instances.get(e.ids.instance))?.baseUrl).toBe(
      'https://moved.example.test/acme',
    );
    const creds = await s.w.storage.credentials.list();
    expect(creds.length).toBeGreaterThan(0);
    expect(creds.every((c) => c.revokedAt !== null)).toBe(true);
    expect(await auditActions(s)).toContain('instance.retarget:ok');
  });
});

describe('credentials', () => {
  it('stores a typed token and never shows it again: not in a page, a redirect, a cookie, the audit log or the logs', async () => {
    const e = await env();
    const { s, admin } = e;
    const token = secret('typed');
    const res = await submit(s, '/admin/credentials', admin, {
      instanceId: e.ids.instance,
      scope: 'shared',
      label: 'Typed credential',
      token,
    });
    expect(res.status).toBe(303);
    expect(flashOf(res)).toBe('created');
    const id = idIn(location(res));
    const everything = [
      location(res) ?? '',
      res.headers.getSetCookie().join('\n'),
      await (await page(s, location(res) as string, admin)).text(),
      await (await page(s, '/admin/credentials', admin)).text(),
      await (await page(s, `/admin/credentials/${id}/token`, admin)).text(),
      JSON.stringify(await s.rows()),
      s.w.logs.join('\n'),
    ].join('\n');
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(token.slice(2, 20));
    const stored = await s.w.storage.credentials.get(id);
    expect(stored?.tokenHint).toBe(token.slice(-4));
    expect(stored?.ownerUserId).toBeNull();
    // The hint, as a tail, is all a page has.
    expect(await (await page(s, `/admin/credentials/${id}`, admin)).text()).toContain(`…${token.slice(-4)}`);
  });

  it('never echoes the token back on a form that fails, whatever the failure', async () => {
    const e = await env();
    const { s, admin } = e;
    const token = secret('echo');
    const base = { instanceId: e.ids.instance, scope: 'shared', label: 'Echo test', token };
    const failures: Array<[string, Record<string, string>]> = [
      ['label too long', { ...base, label: 'x'.repeat(300) }],
      ['no instance', { ...base, instanceId: '' }],
      ['unknown instance', { ...base, instanceId: 'ins_nope' }],
      ['token with a space', { ...base, token: `${token} ${token}` }],
      ['scope nonsense', { ...base, scope: 'everyone' }],
    ];
    for (const [name, fields] of failures) {
      const res = await submit(s, '/admin/credentials', admin, fields);
      const body = await res.text();
      expect([422, 303], name).toContain(res.status);
      expect(body, name).not.toContain(token);
      expect(location(res) ?? '', name).not.toContain(token);
      expect(res.headers.getSetCookie().join(';'), name).not.toContain(token);
      // The token field is a password field with no value, whatever was typed.
      if (res.status === 422) {
        expect(body, name).toMatch(
          /<input[^>]*id="token"[^>]*type="password"|<input[^>]*type="password"[^>]*id="token"/,
        );
        expect(body, name).not.toMatch(/<input[^>]*type="password"[^>]*value=/);
        expect(body, name).toMatch(/autocomplete="off"/);
      }
    }
    expect((await s.w.storage.credentials.list()).some((c) => c.label === 'Echo test')).toBe(false);
    expect(JSON.stringify(await s.rows())).not.toContain(token);
    expect(s.w.logs.join('\n')).not.toContain(token);
  });

  it('asks for a recent sign-in before replacing a token, changes nothing without it, and shows nothing of the token', async () => {
    const e = await env();
    const { s, owner } = e;
    const before = await s.w.storage.credentials.get(e.ids.shared);
    const token = secret('replace');
    const path = `/admin/credentials/${e.ids.shared}/token`;
    s.w.now.t += 11 * MIN;
    const stale = await submit(s, path, owner, { token });
    expect(stale.status).toBe(403);
    const staleBody = await stale.text();
    expect(staleBody).toContain(`/auth/reauth?next=${encodeURIComponent(path)}`);
    expect(staleBody).not.toContain(token);
    expect(await s.w.storage.credentials.get(e.ids.shared)).toEqual(before);
    expect((await s.rows()).filter((r) => r.action === 'credential.replace_token')).toMatchObject([
      { status: 'denied', details: { error: 'reauth_required' } },
    ]);
    // After signing in again (a fresh session), the same form works.
    const fresh = await s.session(OWNER);
    const done = await submit(s, path, fresh, { token });
    expect(done.status).toBe(303);
    expect(flashOf(done)).toBe('saved');
    const after = await s.w.storage.credentials.get(e.ids.shared);
    expect(after?.tokenHint).toBe(token.slice(-4));
    expect(after?.tokenHint).not.toBe(before?.tokenHint);
    expect(JSON.stringify(await s.rows())).not.toContain(token);
  });

  it("offers no token replacement for someone else's personal credential, and the API refuses a forged one", async () => {
    const e = await env();
    const { s, owner, admin } = e;
    for (const who of [admin, owner]) {
      const detail = await (await page(s, `/admin/credentials/${e.ids.aliceCredential}`, who)).text();
      expect(detail).not.toContain('Replace the token…');
      expect(detail).toContain('Only the person this personal credential belongs to');
      expect((await page(s, `/admin/credentials/${e.ids.aliceCredential}/token`, who)).status).toBe(404);
      const before = await s.w.storage.credentials.get(e.ids.aliceCredential);
      const token = secret('forged');
      const res = await submit(s, `/admin/credentials/${e.ids.aliceCredential}/token`, who, { token });
      expect([303, 404]).toContain(res.status);
      expect(await s.w.storage.credentials.get(e.ids.aliceCredential)).toEqual(before);
      expect(await res.text()).not.toContain(token);
    }
    // Hints only, for everyone: the list shows the owner, never a token.
    const list = await (await page(s, '/admin/credentials', admin)).text();
    expect(list).toContain('alice@example.test');
    expect(list).toContain('personal: ');
    // An admin's own personal credential is theirs to rotate.
    const mine = await submit(s, '/admin/credentials', admin, {
      instanceId: e.ids.instance,
      scope: 'mine',
      label: 'Admin personal',
      token: secret('mine'),
    });
    const id = idIn(location(mine));
    expect((await s.w.storage.credentials.get(id))?.ownerUserId).toBe(e.ids.admin);
    expect(await (await page(s, `/admin/credentials/${id}`, admin)).text()).toContain('Replace the token…');
    expect(
      (await submit(s, `/admin/credentials/${id}/token`, admin, { token: secret('mine2') })).status,
    ).toBe(303);
  });

  it('confirms revoking and deleting, validates, renames', async () => {
    const e = await env();
    const { s, admin } = e;
    const path = `/admin/credentials/${e.ids.shared}`;
    expect(flashOf(await submit(s, `${path}/validate`, admin))).toBe('validated');
    expect(flashOf(await submit(s, path, admin, { label: 'Renamed' }))).toBe('saved');
    expect((await s.w.storage.credentials.get(e.ids.shared))?.label).toBe('Renamed');
    const ask = await submit(s, `${path}/revoke`, admin);
    expect(ask.status).toBe(200);
    expect(await ask.text()).toContain('Revoke Renamed?');
    expect((await s.w.storage.credentials.get(e.ids.shared))?.revokedAt).toBeNull();
    expect(flashOf(await submit(s, `${path}/revoke`, admin, { confirm: 'yes' }))).toBe('revoked');
    expect((await s.w.storage.credentials.get(e.ids.shared))?.revokedAt).not.toBeNull();
    // One a grant uses cannot be deleted.
    const refused = await submit(s, `${path}/delete`, admin, { confirm: 'yes' });
    expect(flashOf(refused)).toBe('conflict');
    expect(await s.w.storage.credentials.get(e.ids.shared)).not.toBeNull();
  });
});

describe('workspaces', () => {
  const ADD = (e: E, over: Record<string, string | string[]> = {}) => ({
    instanceId: e.ids.instance,
    slug: 'new-ws',
    name: 'New workspace',
    scopes: 'Scope:1001, 2001',
    tools_all: '1',
    ...over,
  });

  it('creates, edits, disables, enables and deletes a workspace as an admin', async () => {
    const e = await env();
    const { s, admin } = e;
    const created = await submit(
      s,
      '/admin/workspaces',
      admin,
      ADD(e, { limit_maxRows: '50', types_allow: 'Story, Defect', children: '1' }),
    );
    expect(created.status).toBe(303);
    expect(flashOf(created)).toBe('created');
    const id = idIn(location(created));
    expect(await s.w.storage.workspaces.get(id)).toMatchObject({
      slug: 'new-ws',
      allowedScopeIds: ['Scope:1001', 'Scope:2001'],
      includeChildScopes: true,
      enabledTools: null,
      limits: { maxRows: 50 },
      assetTypes: { allow: ['Story', 'Defect'] },
    });
    const edit = await submit(s, `/admin/workspaces/${id}/edit`, admin, {
      name: 'Renamed',
      scopes: 'Scope:1001',
      tools: ['whoami'],
      limit_maxRows: '20',
    });
    expect(edit.status).toBe(303);
    expect(await s.w.storage.workspaces.get(id)).toMatchObject({
      name: 'Renamed',
      allowedScopeIds: ['Scope:1001'],
      includeChildScopes: false,
      enabledTools: ['whoami'],
      limits: { maxRows: 20 },
      assetTypes: null,
    });
    expect((await submit(s, `/admin/workspaces/${id}/disable`, admin)).status).toBe(200);
    expect((await s.w.storage.workspaces.get(id))?.disabledAt).toBeNull();
    expect(flashOf(await submit(s, `/admin/workspaces/${id}/disable`, admin, { confirm: 'yes' }))).toBe(
      'disabled',
    );
    expect((await s.w.storage.workspaces.get(id))?.disabledAt).not.toBeNull();
    expect(flashOf(await submit(s, `/admin/workspaces/${id}/enable`, admin))).toBe('enabled');
    expect((await s.w.storage.workspaces.get(id))?.disabledAt).toBeNull();
    const ask = await submit(s, `/admin/workspaces/${e.ids.workspaceA}/delete`, admin);
    expect(await ask.text()).toMatch(/its \d+ grants?/);
    expect(await s.w.storage.workspaces.get(e.ids.workspaceA)).not.toBeNull();
    expect(
      flashOf(await submit(s, `/admin/workspaces/${e.ids.workspaceA}/delete`, admin, { confirm: 'yes' })),
    ).toBe('deleted');
    expect(await s.w.storage.workspaces.get(e.ids.workspaceA)).toBeNull();
    expect((await s.w.storage.grants.list({ workspaceId: e.ids.workspaceA })).length).toBe(0);
  });

  it('shows field errors next to the field, keeps what was typed and changes nothing', async () => {
    const e = await env();
    const before = await state(e.s);
    const bad = await submit(
      e.s,
      '/admin/workspaces',
      e.admin,
      ADD(e, { slug: 'Bad Slug', scopes: 'Scope:x', limit_maxRows: '99999', name: 'Typed name' }),
    );
    const html = await bad.text();
    expect(bad.status).toBe(422);
    expect(html).toContain('value="Typed name"');
    expect(html.match(/class="error"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(await state(e.s)).toBe(before);
    // A rule only the storage knows (the slug is taken) comes back as a sentence beside the form, and nothing is stored.
    const taken = await submit(e.s, '/admin/workspaces', e.admin, ADD(e, { slug: 'team-a' }));
    expect(taken.status).toBe(422);
    expect(await taken.text()).toContain('class="flash flash-error"');
    expect(await state(e.s)).toBe(before);
  });

  it('keeps write settings, write tools and pass-through to owners with a recent sign-in', async () => {
    const e = await env();
    const { s, owner, admin } = e;
    const edit = `/admin/workspaces/${e.ids.workspaceA}/edit`;
    // The controls: owners see them, admins do not (and see no write tool either).
    const ownerForm = await (await page(s, edit, owner)).text();
    expect(ownerForm).toContain('name="writes"');
    expect(ownerForm).toContain('name="source"');
    expect(ownerForm).toContain(`value="${WRITE_TOOL}"`);
    const adminForm = await (await page(s, edit, admin)).text();
    expect(adminForm).not.toContain('name="writes"');
    expect(adminForm).not.toContain('name="source"');
    expect(adminForm).not.toContain(`value="${WRITE_TOOL}"`);
    expect(adminForm).toContain('only an owner can enable them');
    // Forged by an admin: the panel never reads the owner's fields from an admin's form; a write tool is sent and the API
    // refuses it. Nothing changes either way, and the API refuses the same changes called directly.
    const base = { name: 'Team A', scopes: 'Scope:1001', tools_all: '1' };
    for (const forged of [{ writes: '1' }, { source: 'passthrough' }]) {
      const res = await submit(s, edit, admin, { ...base, ...forged });
      expect(res.status, JSON.stringify(forged)).toBe(303);
      expect(await s.w.storage.workspaces.get(e.ids.workspaceA)).toMatchObject({
        writePolicy: {},
        credentialSource: 'stored',
      });
    }
    const before = await state(s);
    const tool = await submit(s, edit, admin, { ...base, tools: WRITE_TOOL });
    expect(tool.status).toBe(303);
    expect(flashOf(tool)).toBe('not_allowed');
    expect(await state(s)).toBe(before);
    for (const body of [
      { writePolicy: { enabled: true } },
      { credentialSource: 'passthrough' },
      { enabledTools: [WRITE_TOOL] },
    ]) {
      expect((await s.api('PATCH', `/workspaces/${e.ids.workspaceA}`, admin, body)).status).toBe(403);
    }
    expect(await state(s)).toBe(before);
    expect((await auditActions(s)).filter((a) => a === 'workspace.update:denied').length).toBe(4);
    // A stale owner session is asked to sign in again for a write setting; a fresh one changes it.
    s.w.now.t += 11 * MIN;
    const stale = await submit(s, edit, owner, { ...base, writes: '1' });
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain('/auth/reauth?next=');
    expect(await state(s)).toBe(before);
    const fresh = await s.session(OWNER);
    const own = { name: 'Team A', scopes: 'Scope:1001', writes: '1', tools: ['whoami', WRITE_TOOL] };
    expect((await submit(s, edit, fresh, own)).status).toBe(303);
    expect(await s.w.storage.workspaces.get(e.ids.workspaceA)).toMatchObject({
      writePolicy: { enabled: true },
      enabledTools: ['whoami', WRITE_TOOL],
    });
    // An admin saving another change leaves the owner's tool list and write switch alone.
    const kept = await submit(s, edit, admin, {
      name: 'Team A renamed',
      scopes: 'Scope:1001',
      tools_all: '1',
    });
    expect(kept.status).toBe(303);
    expect(await s.w.storage.workspaces.get(e.ids.workspaceA)).toMatchObject({
      name: 'Team A renamed',
      writePolicy: { enabled: true },
      enabledTools: ['whoami', WRITE_TOOL],
    });
    expect(await (await page(s, edit, admin)).text()).toContain('only an owner can change its tool list');
    // "All tools" plus a ticked write tool is an explicit list: write tools are never implied by "all".
    const mixed = await submit(s, edit, fresh, {
      name: 'Team A',
      scopes: 'Scope:1001',
      tools_all: '1',
      tools: WRITE_TOOL,
      writes: '1',
    });
    expect(mixed.status).toBe(303);
    const list = (await s.w.storage.workspaces.get(e.ids.workspaceA))?.enabledTools as string[];
    expect(list).toContain(WRITE_TOOL);
    expect(list).toContain('whoami');
    // Every read tool plus the one write tool that was ticked: the other write tools are not implied (P7-04 adds some).
    expect(list.length).toBe([...TOOLS.values()].filter((t) => t.kind === 'read').length + 1);
  });
});

describe('grants', () => {
  it('creates a person grant and a service grant, edits, and shows the notes the API would warn about', async () => {
    const e = await env();
    const { s, admin } = e;
    const res = await submit(s, '/admin/grants', admin, {
      workspaceId: e.ids.workspaceA,
      who: e.ids.alice,
      credential: e.ids.aliceCredential,
      tools: ['whoami'],
      scopes_all: '1',
      expiry: '90',
      perMinute: '30',
      limit_maxRows: '10',
    });
    expect(res.status).toBe(303);
    expect(flashOf(res)).toBe('created');
    const id = idIn(location(res));
    expect(await s.w.storage.grants.get(id)).toMatchObject({
      userId: e.ids.alice,
      credentialId: e.ids.aliceCredential,
      tools: ['whoami'],
      scopeIds: null,
      limits: { maxRows: 10 },
      rateLimit: { perMinute: 30 },
      expiresAt: s.w.now.t + 90 * 86_400_000,
    });
    // A service grant needs a name, and (being read-only) takes a shared credential.
    const nameless = await submit(s, '/admin/grants', admin, {
      workspaceId: e.ids.workspaceA,
      who: '',
      credential: e.ids.shared,
      tools_all: '1',
      scopes_all: '1',
    });
    expect(nameless.status).toBe(422);
    expect(await nameless.text()).toContain('A service grant needs a name');
    // Edit: a limit above the workspace's is stored and explained on the grant page.
    await s.api('PATCH', `/workspaces/${e.ids.workspaceA}`, e.owner, { limits: { maxRows: 5 } });
    const edit = await submit(s, `/admin/grants/${id}/edit`, admin, {
      credential: e.ids.aliceCredential,
      tools_all: '1',
      scopes_all: '1',
      limit_maxRows: '50',
      expiry: 'keep',
    });
    expect(edit.status).toBe(303);
    expect((await s.w.storage.grants.get(id))?.limits).toEqual({ maxRows: 50 });
    expect((await s.w.storage.grants.get(id))?.expiresAt).toBe(s.w.now.t + 90 * 86_400_000);
    const detail = await (await page(s, `/admin/grants/${id}`, admin)).text();
    expect(detail).toContain('maxRows (50) is above the workspace&#39;s (5)');
  });

  it("the hourly write limit is the owner's: only the owner sees the field, the admin's save keeps it, and a value above the server's is refused beside the form (P7-15)", async () => {
    const e = await env({ writeRateCap: 20 });
    const { s, admin, owner } = e;
    const grant = e.ids.aliceGrant;
    const base = { credential: e.ids.aliceCredential, tools_all: '1', scopes_all: '1', expiry: 'keep' };
    expect(await (await page(s, `/admin/grants/${grant}/edit`, admin)).text()).not.toContain(
      'name="writesPerHour"',
    );
    expect(await (await page(s, `/admin/grants/${grant}/edit`, owner)).text()).toContain(
      'name="writesPerHour"',
    );
    // The owner sets it (with the per-minute rate beside it).
    const set = await submit(s, `/admin/grants/${grant}/edit`, owner, {
      ...base,
      perMinute: '30',
      writesPerHour: '5',
    });
    expect(set.status).toBe(303);
    expect((await s.w.storage.grants.get(grant))?.rateLimit).toEqual({ perMinute: 30, writesPerHour: 5 });
    expect(await (await page(s, `/admin/grants/${grant}`, admin)).text()).toContain('5 (an owner&#39;s cap)');
    // The admin saves the form (no such field): the limit is kept, and the per-minute rate can change.
    const kept = await submit(s, `/admin/grants/${grant}/edit`, admin, { ...base, perMinute: '40' });
    expect(kept.status).toBe(303);
    expect((await s.w.storage.grants.get(grant))?.rateLimit).toEqual({ perMinute: 40, writesPerHour: 5 });
    // A forged field from the admin changes nothing either: the form ignores it and keeps the stored value.
    const forged = await submit(s, `/admin/grants/${grant}/edit`, admin, {
      ...base,
      perMinute: '40',
      writesPerHour: '1000',
    });
    expect(forged.status).toBe(303);
    expect((await s.w.storage.grants.get(grant))?.rateLimit).toEqual({ perMinute: 40, writesPerHour: 5 });
    // Above the server's limit, a fraction and text: refused with the message beside the field, nothing stored.
    for (const bad of ['21', '1.5', 'many', '0']) {
      const res = await submit(s, `/admin/grants/${grant}/edit`, owner, {
        ...base,
        perMinute: '40',
        writesPerHour: bad,
      });
      expect(res.status, bad).toBe(422);
      expect(await res.text(), bad).toMatch(/writesPerHour|Writes per hour/);
    }
    expect((await s.w.storage.grants.get(grant))?.rateLimit).toEqual({ perMinute: 40, writesPerHour: 5 });
    // Blank removes it.
    const cleared = await submit(s, `/admin/grants/${grant}/edit`, owner, {
      ...base,
      perMinute: '40',
      writesPerHour: '',
    });
    expect(cleared.status).toBe(303);
    expect((await s.w.storage.grants.get(grant))?.rateLimit).toEqual({ perMinute: 40 });
  });

  it('refuses what the workspace and credential rules refuse, with the message beside the form', async () => {
    const e = await env();
    const { s, admin } = e;
    const before = await state(s);
    // Alice's personal credential on Bob's grant, a project outside the workspace, an unknown tool.
    const wrong = await submit(s, '/admin/grants', admin, {
      workspaceId: e.ids.workspaceA,
      who: e.ids.alice,
      credential: e.ids.bobCredential,
      tools_all: '1',
      scopes_all: '1',
    });
    expect(wrong.status).toBe(422);
    expect(await state(s)).toBe(before);
    const noProject = await submit(s, '/admin/grants', admin, {
      workspaceId: e.ids.workspaceA,
      who: e.ids.alice,
      credential: e.ids.aliceCredential,
      tools_all: '1',
    });
    expect(noProject.status).toBe(422);
    expect(await noProject.text()).toContain('Choose at least one project');
    expect(await state(s)).toBe(before);
  });

  it('keeps write tools to owners with a recent sign-in: hidden from admins, refused when forged', async () => {
    const e = await env();
    const { s, owner, admin } = e;
    await s.api('PATCH', `/workspaces/${e.ids.workspaceA}`, owner, {
      enabledTools: ['whoami', WRITE_TOOL],
      writePolicy: { enabled: true },
    });
    const form = `/admin/grants/new?workspace=${e.ids.workspaceA}`;
    expect(await (await page(s, form, owner)).text()).toContain(`value="${WRITE_TOOL}"`);
    const adminForm = await (await page(s, form, admin)).text();
    expect(adminForm).not.toContain(`value="${WRITE_TOOL}"`);
    const fields = {
      workspaceId: e.ids.workspaceA,
      who: e.ids.alice,
      credential: e.ids.aliceCredential,
      tools: ['whoami', WRITE_TOOL],
      scopes_all: '1',
    };
    const before = await state(s);
    const forged = await submit(s, '/admin/grants', admin, fields);
    expect([303, 403]).toContain(forged.status);
    expect(await state(s)).toBe(before);
    s.w.now.t += 11 * MIN;
    const stale = await submit(s, '/admin/grants', owner, fields);
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain('/auth/reauth?next=');
    expect(await state(s)).toBe(before);
    const fresh = await s.session(OWNER);
    expect((await submit(s, '/admin/grants', fresh, fields)).status).toBe(303);
    // A grant that already has a write tool: an admin saving other changes leaves its tools alone.
    const grant = (
      await s.w.storage.grants.list({ userId: e.ids.alice, workspaceId: e.ids.workspaceA })
    ).find((g) => g.tools?.includes(WRITE_TOOL));
    expect(grant).toBeDefined();
    const kept = await submit(s, `/admin/grants/${grant?.id}/edit`, admin, {
      credential: e.ids.aliceCredential,
      tools_all: '1',
      scopes_all: '1',
      limit_maxRows: '7',
      expiry: 'keep',
    });
    expect(kept.status).toBe(303);
    expect((await s.w.storage.grants.get(grant?.id as string))?.tools).toEqual(['whoami', WRITE_TOOL]);
    expect((await s.w.storage.grants.get(grant?.id as string))?.limits).toEqual({ maxRows: 7 });
  });

  it('revokes and deletes behind a confirmation page', async () => {
    const e = await env();
    const { s, admin } = e;
    const path = `/admin/grants/${e.ids.serviceGrant}`;
    const ask = await submit(s, `${path}/revoke`, admin);
    expect(await ask.text()).toContain('Revoke this grant?');
    expect((await s.w.storage.grants.get(e.ids.serviceGrant))?.revokedAt).toBeNull();
    expect(flashOf(await submit(s, `${path}/revoke`, admin, { confirm: 'yes' }))).toBe('revoked');
    expect((await s.w.storage.grants.get(e.ids.serviceGrant))?.revokedAt).not.toBeNull();
    // A revoked grant offers no new token.
    expect(await (await page(s, path, admin)).text()).toContain('cannot get new device tokens');
    expect((await page(s, `${path}/tokens/new`, admin)).status).toBe(409);
    expect(flashOf(await submit(s, `${path}/delete`, admin, { confirm: 'yes' }))).toBe('deleted');
    expect(await s.w.storage.grants.get(e.ids.serviceGrant)).toBeNull();
  });
});

describe('device tokens: shown once', () => {
  const NEW = (e: E, grant = e.ids.serviceGrant) => `/admin/grants/${grant}/tokens/new`;
  const ISSUE = (e: E, grant = e.ids.serviceGrant) => `/admin/grants/${grant}/tokens`;
  const handleOf = (html: string) => /name="_once" value="([^"]+)"/.exec(html)?.[1] as string;
  const onceRows = (s: S) => s.w.storage.kv.list('ui-once:');
  const tokenCount = async (s: S) => (await s.w.storage.accessTokens.list()).length;

  it('issues a token on the answer to the POST, no-store, and a reload mints no second one', async () => {
    const e = await env();
    const { s, admin } = e;
    const form = await (await page(s, NEW(e), admin)).text();
    const once = handleOf(form);
    expect(once).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const before = await tokenCount(s);
    const fields = { label: 'laptop', lifetime: '30', _once: once };
    const issued = await submit(s, ISSUE(e), admin, fields);
    const html = await issued.text();
    expect(issued.status).toBe(200);
    expect(issued.headers.get('cache-control')).toBe('no-store');
    expect(issued.headers.get('location')).toBeNull();
    expect(issued.headers.getSetCookie().join(';')).not.toContain('ab_');
    const token = /<code id="token">([^<]+)<\/code>/.exec(html)?.[1] as string;
    expect(token).toMatch(/^ab_/);
    // The token box, and the one snippet (JetBrains) whose client can neither prompt for it nor read a variable (P4-06).
    expect(html.split(token).length - 1).toBe(2);
    expect(html.split(`Bearer ${token}`).length - 1).toBe(1);
    expect(await tokenCount(s)).toBe(before + 1);
    // The new token is a real one: it opens the workspace's MCP endpoint.
    const ok = await mcpPost(s.w, 'team-a', token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    expect(ok.status).toBe(200);
    // Nothing else holds it: not the audit log, not the logs, not storage as clear text.
    expect(JSON.stringify(await s.rows())).not.toContain(token);
    expect(s.w.logs.join('\n')).not.toContain(token);
    // Reload (re-sending the form), the back button, a replay: nothing is issued, nothing is shown.
    for (let i = 0; i < 3; i++) {
      const again = await submit(s, ISSUE(e), admin, fields);
      expect(again.status).toBe(303);
      expect(flashOf(again)).toBe('token_form_used');
      expect(location(again)).toBe(`/admin/grants/${e.ids.serviceGrant}`);
      expect(await again.text()).not.toContain(token);
      expect(await tokenCount(s)).toBe(before + 1);
    }
    expect((await onceRows(s)).length).toBe(0);
    expect((await auditActions(s)).filter((a) => a === 'token.issue:ok').length).toBe(1);
  });

  it('issues exactly one token for a form sent twice at once', async () => {
    const e = await env();
    const { s, owner } = e;
    const once = handleOf(await (await page(s, NEW(e), owner)).text());
    const before = await tokenCount(s);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        submit(s, ISSUE(e), owner, { label: 'race', lifetime: '90', _once: once }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 303)).toHaveLength(5);
    expect(await tokenCount(s)).toBe(before + 1);
  });

  it('refuses a missing, forged, repeated, spent or foreign handle, and issues nothing', async () => {
    const e = await env();
    const { s, owner, admin } = e;
    const before = await tokenCount(s);
    const mine = handleOf(await (await page(s, NEW(e), admin)).text());
    const spent = handleOf(await (await page(s, NEW(e), owner)).text());
    const cases: Array<[string, Session, string]> = [
      ['none', admin, enc({ _csrf: admin.csrf, label: 'x', lifetime: '90' })],
      ['forged', admin, enc({ _csrf: admin.csrf, label: 'x', lifetime: '90', _once: 'A'.repeat(22) })],
      ['malformed', admin, enc({ _csrf: admin.csrf, label: 'x', lifetime: '90', _once: '../../../etc' })],
      [
        'twice',
        admin,
        `${enc({ _csrf: admin.csrf, label: 'x', lifetime: '90', _once: mine })}&_once=${mine}`,
      ],
      // The owner's handle is not the admin's: the key holds the user id.
      ['foreign', admin, enc({ _csrf: admin.csrf, label: 'x', lifetime: '90', _once: spent })],
    ];
    for (const [name, who, body] of cases) {
      const res = await s.send('POST', ISSUE(e), { cookie: who.cookie, form: body });
      expect(res.status, name).toBe(303);
      expect(flashOf(res), name).toBe('token_form_used');
    }
    expect(await tokenCount(s)).toBe(before);
    // The handles those cases did not spend are still good for their owners.
    expect((await submit(s, ISSUE(e), admin, { label: 'x', lifetime: '90', _once: mine })).status).toBe(200);
    expect((await submit(s, ISSUE(e), owner, { label: 'x', lifetime: '90', _once: spent })).status).toBe(200);
    expect(await tokenCount(s)).toBe(before + 2);
  });

  it('writes one handle for the page that shows the form, none for HEAD, the lists or a refused view, and caps them', async () => {
    const e = await env();
    const { s, admin, alice } = e;
    for (const path of [
      '/admin/grants',
      `/admin/grants/${e.ids.serviceGrant}`,
      '/admin/instances',
      '/admin/users',
    ]) {
      await page(s, path, admin);
      await s.send('HEAD', path, { cookie: admin.cookie, site: 'none' });
    }
    await s.send('HEAD', NEW(e), { cookie: admin.cookie, site: 'none' });
    expect((await onceRows(s)).length).toBe(0);
    // A member, a stranger and a cross-site fetch write nothing either.
    await page(s, NEW(e), alice);
    await page(s, NEW(e), undefined);
    await page(s, NEW(e), admin, { 'sec-fetch-site': 'cross-site' });
    expect((await onceRows(s)).length).toBe(0);
    await page(s, NEW(e), admin);
    expect((await onceRows(s)).length).toBe(1);
    // Past the cap, a page hands out one of the open handles instead of writing another row.
    for (let i = 0; i < 25; i++) await page(s, NEW(e), admin);
    expect((await onceRows(s)).length).toBe(10);
    const handles = new Set<string>();
    for (let i = 0; i < 30; i++) handles.add(handleOf(await (await page(s, NEW(e), admin)).text()));
    expect((await onceRows(s)).length).toBe(10);
    const open = new Set((await onceRows(s)).map((k) => k.split(':').pop()));
    for (const h of handles) expect(open.has(h)).toBe(true);
    // A re-rendered form (a validation error) carries a fresh handle and does not spend the old one.
    const once = [...open][0] as string;
    const invalid = await submit(s, ISSUE(e), admin, { label: '', lifetime: '90', _once: once });
    expect(invalid.status).toBe(422);
    expect((await onceRows(s)).some((k) => k.endsWith(`:${once}`))).toBe(true);
  });

  it("offers no token for a grant on someone else's personal credential, and the API refuses a forged request", async () => {
    const e = await env();
    const { s, owner, admin } = e;
    for (const who of [owner, admin]) {
      const detail = await (await page(s, `/admin/grants/${e.ids.aliceGrant}`, who)).text();
      expect(detail).not.toContain('New device token');
      expect(detail).toContain('Only the person');
      expect((await page(s, NEW(e, e.ids.aliceGrant), who)).status).toBe(409);
      // Forged: a handle from a grant that does allow it.
      const once = handleOf(await (await page(s, NEW(e), who)).text());
      const before = await tokenCount(s);
      const res = await submit(s, ISSUE(e, e.ids.aliceGrant), who, {
        label: 'forged',
        lifetime: '90',
        _once: once,
      });
      expect([303, 403]).toContain(res.status);
      expect(await tokenCount(s)).toBe(before);
      expect(await res.text()).not.toMatch(/<code id="token">/);
    }
    expect((await auditActions(s)).filter((a) => a === 'token.issue:denied').length).toBeGreaterThanOrEqual(
      1,
    );
    // The grant of a service on a shared credential does get the button.
    expect(await (await page(s, `/admin/grants/${e.ids.serviceGrant}`, admin)).text()).toContain(
      'New device token',
    );
  });

  it('revokes a token behind a confirmation page, and refuses members', async () => {
    const e = await env();
    const { s, owner, admin, alice } = e;
    const once = handleOf(await (await page(s, NEW(e), admin)).text());
    await submit(s, ISSUE(e), admin, { label: 'phone', lifetime: '30', _once: once });
    const tok = (await s.w.storage.accessTokens.list({ grantId: e.ids.serviceGrant }))[0];
    const path = `/admin/grants/${e.ids.serviceGrant}/tokens/${tok?.id}/revoke`;
    const list = await (await page(s, `/admin/grants/${e.ids.serviceGrant}`, admin)).text();
    expect(list).toContain('phone');
    expect(list).toContain(`${tok?.prefix}…`);
    expect((await submit(s, path, alice)).status).toBe(403);
    const ask = await submit(s, path, admin);
    expect(await ask.text()).toContain('Revoke the token of phone?');
    expect((await s.w.storage.accessTokens.get(tok?.id as string))?.revokedAt).toBeNull();
    expect(flashOf(await submit(s, path, owner, { confirm: 'yes' }))).toBe('revoked');
    expect((await s.w.storage.accessTokens.get(tok?.id as string))?.revokedAt).not.toBeNull();
  });
});

describe('users', () => {
  /** A fresh user of this role (for an owner target, with a second owner so the last-owner rule stays out of it). */
  async function target(e: E, role: 'owner' | 'admin' | 'member', n: number) {
    const res = await e.s.api('POST', '/users', e.owner, { email: `t${n}-${role}@example.test`, role });
    return (await res.json()).id as string;
  }

  it('offers exactly the buttons the admin API allows, for every viewer and target role', async () => {
    const e = await env();
    const { s } = e;
    const viewers = [
      ['owner', e.owner],
      ['admin', e.admin],
    ] as const;
    let n = 0;
    await target(e, 'owner', 99); // never the last owner
    for (const [viewerRole, who] of viewers) {
      for (const role of ['owner', 'admin', 'member'] as const) {
        const html = async (id: string) => await (await page(s, `/admin/users/${id}`, who)).text();
        // Editing the name.
        let id = await target(e, role, ++n);
        let doc = await html(id);
        const offersEdit = doc.includes(`aria-label="Edit the person"`);
        const edit = await s.api('PATCH', `/users/${id}`, who, { displayName: 'Changed' });
        expect(offersEdit, `${viewerRole} edits ${role}`).toBe(edit.status === 200);
        // The role form: owners only; an admin's API attempt to promote is refused.
        id = await target(e, role, ++n);
        doc = await html(id);
        const offersRole = doc.includes('aria-label="Change the role"');
        const promote = await s.api('PATCH', `/users/${id}`, who, {
          role: role === 'admin' ? 'owner' : 'admin',
        });
        expect(offersRole, `${viewerRole} role of ${role}`).toBe(promote.status === 200);
        // Disabling.
        id = await target(e, role, ++n);
        doc = await html(id);
        const offersDisable = doc.includes('Disable…');
        const disable = await s.api('POST', `/users/${id}/disable`, who);
        expect(offersDisable, `${viewerRole} disables ${role}`).toBe(disable.status === 200);
        // Ending sessions.
        id = await target(e, role, ++n);
        doc = await html(id);
        const offersEnd = doc.includes('End their sessions…');
        const end = await s.api('POST', `/users/${id}/sessions/revoke`, who);
        expect(offersEnd, `${viewerRole} ends sessions of ${role}`).toBe(end.status === 200);
      }
      // Yourself: sessions always, the rest as the API says.
      const self = await (
        await page(s, `/admin/users/${viewerRole === 'owner' ? e.ids.owner : e.ids.admin}`, who)
      ).text();
      expect(self).toContain('End their sessions…');
      // Disabling yourself follows the same rule as disabling anyone: an admin may not (the API refuses), an owner may.
      expect(self.includes('Disable…'), `${viewerRole} disables self`).toBe(viewerRole === 'owner');
    }
  });

  it('answers a last-owner refusal with a clear message and changes nothing', async () => {
    const e = await env();
    const { s, owner } = e;
    expect((await s.w.storage.users.list()).filter((u) => u.role === 'owner')).toHaveLength(1);
    const before = await state(s);
    const demote = await submit(s, `/admin/users/${e.ids.owner}/role`, owner, { role: 'member' });
    expect(demote.status).toBe(303);
    expect(flashOf(demote)).toBe('last_owner');
    const disable = await submit(s, `/admin/users/${e.ids.owner}/disable`, owner, { confirm: 'yes' });
    expect(flashOf(disable)).toBe('last_owner');
    expect(await state(s)).toBe(before);
    // The message is shown on the next page, in words.
    const shown = await page(s, `/admin/users/${e.ids.owner}`, owner, {
      cookie: `${owner.cookie}; ab_flash=last_owner`,
    });
    expect(await shown.text()).toContain('without an active owner');
    // The API says the same, with a machine-readable marker.
    const api = await s.api('POST', `/users/${e.ids.owner}/disable`, owner);
    expect(api.status).toBe(403);
    expect((await api.json()).error.detail).toBe('last_owner');
    // With a second owner both work.
    await target(e, 'owner', 1);
    expect(flashOf(await submit(s, `/admin/users/${e.ids.owner}/role`, owner, { role: 'admin' }))).toBe(
      'saved',
    );
  });

  it('keeps owner and admin changes to owners: forged requests from an admin are refused and change nothing', async () => {
    const e = await env();
    const { s, admin } = e;
    const second = await target(e, 'owner', 1);
    const before = await state(s);
    const attempts: Array<[string, Record<string, string>]> = [
      [`/admin/users/${second}`, { displayName: 'Hacked', email: 'hacked@example.test' }],
      [`/admin/users/${second}/role`, { role: 'member' }],
      [`/admin/users/${second}/disable`, { confirm: 'yes' }],
      [`/admin/users/${second}/sessions`, { confirm: 'yes' }],
      [`/admin/users/${e.ids.admin}/role`, { role: 'owner' }],
    ];
    for (const [path, fields] of attempts) {
      const res = await submit(s, path, admin, fields);
      expect([303, 403], path).toContain(res.status);
      if (res.status === 303 && !path.endsWith('/role')) expect(flashOf(res), path).toBe('not_allowed');
    }
    expect(await state(s)).toBe(before);
    // An admin may add a member, not an admin or an owner.
    const member = await submit(s, '/admin/users', admin, {
      email: 'new-member@example.test',
      role: 'member',
      displayName: 'New',
    });
    expect(member.status).toBe(303);
    for (const role of ['admin', 'owner']) {
      const res = await submit(s, '/admin/users', admin, { email: `x-${role}@example.test`, role });
      expect([303, 422, 403], role).toContain(res.status);
      expect((await s.w.storage.users.list()).some((u) => u.email === `x-${role}@example.test`)).toBe(false);
    }
    expect(await (await page(s, '/admin/users/new', admin)).text()).not.toContain('value="owner"');
    expect(await (await page(s, '/admin/users/new', e.owner)).text()).toContain('value="owner"');
    // Duplicate emails are a conflict, said in words.
    const dup = await submit(s, '/admin/users', admin, { email: 'new-member@example.test', role: 'member' });
    expect(dup.status).toBe(422);
  });

  it('asks an owner to sign in again before creating an admin or changing a role, and ends sessions on a role change', async () => {
    const e = await env();
    const { s, owner } = e;
    s.w.now.t += 11 * MIN;
    const before = await state(s);
    const stale = await submit(s, '/admin/users', owner, { email: 'adm@example.test', role: 'admin' });
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain('/auth/reauth?next=');
    const staleRole = await submit(s, `/admin/users/${e.ids.alice}/role`, owner, { role: 'admin' });
    expect(staleRole.status).toBe(403);
    expect(await state(s)).toBe(before);
    const fresh = await s.session(OWNER);
    const alice = await s.session(ALICE);
    expect((await page(s, '/admin', alice)).status).toBe(200);
    expect(flashOf(await submit(s, `/admin/users/${e.ids.alice}/role`, fresh, { role: 'admin' }))).toBe(
      'saved',
    );
    expect((await s.w.storage.users.get(e.ids.alice))?.role).toBe('admin');
    // The role change ended Alice's sessions (the API does it; the panel gets it for free).
    expect((await page(s, '/admin', alice)).status).toBe(303);
  });

  it('ends the sessions of someone else with a confirmation, and of yourself with a sign-out', async () => {
    const e = await env();
    const { s, owner, alice } = e;
    const path = `/admin/users/${e.ids.alice}/sessions`;
    const ask = await submit(s, path, owner);
    expect(await ask.text()).toContain('End the sessions of');
    expect((await page(s, '/admin', alice)).status).toBe(200);
    expect(flashOf(await submit(s, path, owner, { confirm: 'yes' }))).toBe('sessions_ended');
    expect((await page(s, '/admin', alice)).status).toBe(303);
    const mine = await submit(s, `/admin/users/${e.ids.owner}/sessions`, owner, { confirm: 'yes' });
    expect(location(mine)).toBe('/auth/login');
    expect(mine.headers.getSetCookie().join(';')).toMatch(/Max-Age=0/);
  });
});

describe('forms refuse what they must, and refuse it without any effect', () => {
  /** Every POST target of the screens, with fields that would act if the request were let through. */
  const routes = (e: E): Array<[string, Record<string, string | string[]>]> => [
    ['/admin/instances', { label: 'Sneaky', baseUrl: 'https://sneaky.example.test' }],
    [`/admin/instances/${e.ids.instance}`, { label: 'Renamed' }],
    [`/admin/instances/${e.ids.instance}/disable`, { confirm: 'yes' }],
    [`/admin/instances/${e.ids.instance}/enable`, {}],
    [`/admin/instances/${e.ids.instance}/delete`, { confirm: 'yes' }],
    [`/admin/instances/${e.ids.instance}/origin`, { baseUrl: 'https://moved.example.test', understood: '1' }],
    [
      '/admin/credentials',
      { instanceId: e.ids.instance, scope: 'shared', label: 'Sneaky', token: 'x'.repeat(30) },
    ],
    [`/admin/credentials/${e.ids.shared}`, { label: 'Renamed' }],
    [`/admin/credentials/${e.ids.shared}/validate`, {}],
    [`/admin/credentials/${e.ids.shared}/revoke`, { confirm: 'yes' }],
    [`/admin/credentials/${e.ids.shared}/delete`, { confirm: 'yes' }],
    [`/admin/credentials/${e.ids.shared}/token`, { token: 'y'.repeat(30) }],
    [
      '/admin/workspaces',
      { instanceId: e.ids.instance, slug: 'sneaky', name: 'Sneaky', scopes: 'Scope:1', tools_all: '1' },
    ],
    [`/admin/workspaces/${e.ids.workspaceA}/edit`, { name: 'Renamed', scopes: 'Scope:1001', tools_all: '1' }],
    [`/admin/workspaces/${e.ids.workspaceA}/disable`, { confirm: 'yes' }],
    [`/admin/workspaces/${e.ids.workspaceA}/enable`, {}],
    [`/admin/workspaces/${e.ids.workspaceA}/delete`, { confirm: 'yes' }],
    [
      '/admin/grants',
      {
        workspaceId: e.ids.workspaceA,
        who: '',
        label: 'sneaky',
        credential: e.ids.shared,
        tools_all: '1',
        scopes_all: '1',
      },
    ],
    [
      `/admin/grants/${e.ids.serviceGrant}/edit`,
      { credential: e.ids.shared, tools_all: '1', scopes_all: '1', limit_maxRows: '3' },
    ],
    [`/admin/grants/${e.ids.serviceGrant}/revoke`, { confirm: 'yes' }],
    [`/admin/grants/${e.ids.serviceGrant}/delete`, { confirm: 'yes' }],
    [
      `/admin/grants/${e.ids.serviceGrant}/tokens`,
      { label: 'sneaky', lifetime: '30', _once: 'A'.repeat(22) },
    ],
    [`/admin/grants/${e.ids.aliceGrant}/tokens/${e.ids.aliceToken}/revoke`, { confirm: 'yes' }],
    ['/admin/users', { email: 'sneaky@example.test', role: 'member' }],
    [`/admin/users/${e.ids.alice}`, { displayName: 'Sneaky', email: 'alice@example.test' }],
    [`/admin/users/${e.ids.alice}/role`, { role: 'admin' }],
    [`/admin/users/${e.ids.alice}/disable`, { confirm: 'yes' }],
    [`/admin/users/${e.ids.alice}/sessions`, { confirm: 'yes' }],
    [`/admin/users/${e.ids.alice}/unbind`, { confirm: 'yes', email: ALICE }],
  ];

  it('refuses a missing or wrong CSRF token, another site, another content type and a member, and a stranger is sent to sign-in', async () => {
    const e = await env();
    const { s, owner, alice } = e;
    const before = await state(s);
    const auditBefore = (await s.rows()).filter((r) => r.action !== 'admin.forbidden').length;
    let n = 0;
    for (const [path, fields] of routes(e)) {
      n++;
      const name = path;
      const noToken = await s.send('POST', path, {
        cookie: owner.cookie,
        form: enc(fields as Record<string, string>),
      });
      expect(noToken.status, `${name} without a token`).toBe(403);
      const wrong = await submit(s, path, { ...owner, csrf: 'not-the-token' }, fields);
      expect(wrong.status, `${name} wrong token`).toBe(403);
      const twice = await s.send('POST', path, {
        cookie: owner.cookie,
        form: `${enc({ _csrf: owner.csrf, ...fields } as Record<string, string>)}&_csrf=${owner.csrf}`,
      });
      expect(twice.status, `${name} token twice`).toBe(403);
      const cross = await s.send('POST', path, {
        cookie: owner.cookie,
        form: enc({ _csrf: owner.csrf, ...fields } as Record<string, string>),
        site: 'cross-site',
        headers: { origin: 'https://evil.example.test' },
      });
      expect(cross.status, `${name} cross-site`).toBe(403);
      const foreignOrigin = await s.send('POST', path, {
        cookie: owner.cookie,
        form: enc({ _csrf: owner.csrf, ...fields } as Record<string, string>),
        headers: { origin: 'https://evil.example.test' },
      });
      expect(foreignOrigin.status, `${name} foreign origin`).toBe(403);
      const json = await s.send('POST', path, {
        cookie: owner.cookie,
        body: { _csrf: owner.csrf, ...fields },
      });
      expect(json.status, `${name} json`).toBe(415);
      const big = await submit(s, path, owner, { ...fields, pad: 'x'.repeat(20_000) });
      expect(big.status, `${name} too large`).toBe(413);
      const member = await submit(s, path, alice, fields);
      expect(member.status, `${name} member`).toBe(403);
      const stranger = await s.send('POST', path, {
        form: enc({ _csrf: owner.csrf, ...fields } as Record<string, string>),
      });
      expect(stranger.status, `${name} stranger`).toBe(303);
      expect(location(stranger), `${name} stranger`).toContain('/auth/login');
      // A GET on a form target changes nothing (and is not a page).
      const get = await page(s, path, owner);
      expect([404, 405, 200], `${name} GET`).toContain(get.status);
    }
    expect(n).toBeGreaterThan(25);
    expect(await state(s)).toBe(before);
    expect((await s.rows()).filter((r) => r.action !== 'admin.forbidden').length).toBe(auditBefore);
    const reasons = new Set(await forbiddenReasons(s));
    expect(reasons.has('csrf')).toBe(true);
    expect(reasons.has('role')).toBe(true);
  });

  it('writes every change through the admin API: same audit row, same actor, the request id of the panel request', async () => {
    const e = await env();
    const { s, admin } = e;
    // The same instance created through the panel and through the API by the same admin.
    await submit(s, '/admin/instances', admin, {
      label: 'Via panel',
      baseUrl: 'https://a.example.test/acme',
    });
    await s.api('POST', '/instances', admin, { label: 'Via API', baseUrl: 'https://b.example.test/acme' });
    await submit(s, `/admin/grants/${e.ids.serviceGrant}/revoke`, admin, { confirm: 'yes' });
    await s.api('POST', `/grants/${e.ids.aliceGrant}/revoke`, admin);
    await submit(s, `/admin/credentials/${e.ids.shared}/revoke`, admin, { confirm: 'yes' });
    await s.api('POST', `/credentials/${e.ids.aliceCredential}/revoke`, admin);
    const rows = await s.rows();
    for (const action of ['instance.create', 'grant.revoke', 'credential.revoke']) {
      const matching = rows.filter((r) => r.action === action && r.userId === e.ids.admin);
      expect(matching.length, action).toBeGreaterThanOrEqual(2);
      const [first, second] = matching;
      expect({ ...first, id: 0, ts: 0, requestId: '', targetId: '', details: {} }).toEqual({
        ...second,
        id: 0,
        ts: 0,
        requestId: '',
        targetId: '',
        details: {},
      });
      expect(first?.details).toMatchObject({ actor: 'admin', via: 'api' });
      expect(first?.requestId).not.toBeNull();
    }
    expect(rows.filter((r) => r.action === 'instance.create' && r.userId === e.ids.admin)).toHaveLength(2);
  });
});

describe('long lists page', () => {
  it('shows 25 rows a page with previous and next links, and treats a bad page number as the first or last page', async () => {
    const e = await env();
    const { s, owner } = e;
    for (let i = 0; i < 60; i++)
      await s.w.storage.users.create({
        id: `usr_p${String(i).padStart(3, '0')}`,
        email: `p${i}@example.test`,
        role: 'member',
      });
    const count = (html: string) => new Set(html.match(/href="\/admin\/users\/usr_p\d{3}"/g)).size;
    const first = await (await page(s, '/admin/users', owner)).text();
    expect(first).toContain('Next page');
    expect(first).not.toContain('Previous page');
    const total = (await s.w.storage.users.list()).length;
    const p2 = await (await page(s, '/admin/users?page=2', owner)).text();
    expect(p2).toContain('Previous page');
    expect(p2).toContain('Next page');
    const seen = new Set<string>();
    for (let p = 1; p <= Math.ceil(total / 25); p++) {
      const html = await (await page(s, `/admin/users?page=${p}`, owner)).text();
      for (const m of html.matchAll(/href="\/admin\/users\/(usr_[^"]+)"/g)) seen.add(m[1] as string);
      if (p < Math.ceil(total / 25)) expect(html.match(/href="\/admin\/users\/usr_/g)?.length).toBe(25);
    }
    expect(seen.size).toBe(total);
    expect(count(first)).toBeLessThanOrEqual(25);
    for (const bad of ['abc', '-3', '0', '99999999999999', '1.5', '%00']) {
      const res = await page(s, `/admin/users?page=${bad}`, owner);
      expect(res.status, bad).toBe(200);
    }
    const last = await (await page(s, '/admin/users?page=99999', owner)).text();
    expect(last).not.toContain('Next page');
  });
});

describe('the tool catalogue endpoint', () => {
  it('lists tools to owners and admins only', async () => {
    const e = await env();
    const { s, owner, admin, alice } = e;
    for (const who of [owner, admin]) {
      const res = await s.api('GET', '/tools', who);
      expect(res.status).toBe(200);
      const tools = (await res.json()) as Array<{ name: string; kind: string; group: string }>;
      expect(tools.find((t) => t.name === WRITE_TOOL)).toEqual({
        name: WRITE_TOOL,
        kind: 'write',
        group: 'work',
        siblings: [],
        cost: 0,
      });
      expect(tools.length).toBe(TOOLS.size);
    }
    const denied = await s.api('GET', '/tools', alice);
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain(WRITE_TOOL);
    expect((await s.send('GET', '/api/admin/v1/tools')).status).toBe(401);
  });
});

describe('composite grants (P6-11)', () => {
  const REPORT = 'sprint_health';

  it('lists the sibling tools of a composite in the tool catalogue and nothing for the others', async () => {
    const e = await env();
    const tools = (await (await e.s.api('GET', '/tools', e.owner)).json()) as Array<{
      name: string;
      siblings: string[];
    }>;
    expect(tools.find((t) => t.name === REPORT)?.siblings).toEqual(['get_sprint', 'search_work_items']);
    expect(tools.find((t) => t.name === 'whoami')?.siblings).toEqual([]);
  });

  it('warns on the workspace page when a composite is enabled without its siblings, and only then', async () => {
    const e = await env();
    const { s, admin } = e;
    const ws = `/admin/workspaces/${e.ids.workspaceA}`;
    const patch = (enabledTools: string[] | null) =>
      s.api('PATCH', `/workspaces/${e.ids.workspaceA}`, e.owner, { enabledTools });
    expect((await patch(['whoami', REPORT, 'get_sprint'])).status).toBe(200);
    const partial = await (await page(s, ws, admin)).text();
    expect(partial).toContain('sprint_health is granted without search_work_items');
    expect(partial).not.toContain('without get_sprint');
    expect((await patch(['whoami', REPORT, 'get_sprint', 'search_work_items'])).status).toBe(200);
    expect(await (await page(s, ws, admin)).text()).not.toContain('is granted without');
    expect((await patch(['whoami'])).status).toBe(200);
    expect(await (await page(s, ws, admin)).text()).not.toContain('is granted without');
    expect((await patch(null)).status).toBe(200);
    expect(await (await page(s, ws, admin)).text()).not.toContain('is granted without');
  });

  it('warns on the grant page from what the grant can really call: its list inside the workspace list', async () => {
    const e = await env();
    const { s, admin } = e;
    const made = await s.api('POST', '/grants', e.owner, {
      workspaceId: e.ids.workspaceA,
      userId: e.ids.alice,
      credentialId: e.ids.aliceCredential,
      tools: ['whoami', REPORT, 'get_sprint', 'search_work_items'],
    });
    const id = ((await made.json()) as { record: { id: string } }).record.id;
    const detail = `/admin/grants/${id}`;
    expect(await (await page(s, detail, admin)).text()).not.toContain('is granted without');
    // The workspace stops enabling one sibling: the grant's list is intersected with it.
    await s.api('PATCH', `/workspaces/${e.ids.workspaceA}`, e.owner, {
      enabledTools: ['whoami', REPORT, 'get_sprint'],
    });
    const html = await (await page(s, detail, admin)).text();
    expect(html).toContain('sprint_health is granted without search_work_items');
  });

  it('the "check" step re-renders the workspace and grant forms with the notes for the list as ticked, saving nothing (P6-35)', async () => {
    const e = await env();
    const { s, owner, admin } = e;
    const before = JSON.stringify(await s.w.storage.workspaces.get(e.ids.workspaceA));
    const wsEdit = `/admin/workspaces/${e.ids.workspaceA}/edit`;
    const ticked = { check: '1', name: 'x', tools: ['whoami', REPORT, 'get_sprint'] };
    // Edit form of a workspace.
    const edit = await submit(s, wsEdit, admin, ticked);
    expect(edit.status).toBe(200);
    const html = await edit.text();
    expect(html).toContain('sprint_health is granted without search_work_items');
    expect(html).not.toContain('without get_sprint');
    // Nothing was saved.
    expect(JSON.stringify(await s.w.storage.workspaces.get(e.ids.workspaceA))).toBe(before);
    // A complete list, "every read tool" and a list without a composite say nothing.
    for (const fields of [
      { check: '1', tools: ['whoami', REPORT, 'get_sprint', 'search_work_items'] },
      { check: '1', tools_all: '1' },
      { check: '1', tools: ['whoami'] },
    ]) {
      const res = await submit(s, wsEdit, owner, fields);
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain('is granted without');
    }
    // The grant edit form too, and the hostile or unknown names the post carries are not shown as notes.
    const grantEdit = `/admin/grants/${e.ids.aliceGrant}/edit`;
    const g = await submit(s, grantEdit, admin, { check: '1', tools: ['whoami', REPORT] });
    expect(g.status).toBe(200);
    expect(await g.text()).toContain('sprint_health is granted without get_sprint, search_work_items');
    const evil = await submit(s, grantEdit, admin, { check: '1', tools: ['<img src=x onerror=alert(1)>'] });
    expect(await evil.text()).not.toContain('<img src=x');
    // A member cannot use the step.
    expect((await submit(s, grantEdit, e.alice, ticked)).status).not.toBe(200);
  });

  it('shows the warning to owners and admins only: members and strangers get no page', async () => {
    const e = await env();
    await e.s.api('PATCH', `/workspaces/${e.ids.workspaceA}`, e.owner, { enabledTools: ['whoami', REPORT] });
    for (const who of [e.alice, undefined]) {
      const res = await page(e.s, `/admin/workspaces/${e.ids.workspaceA}`, who);
      expect(await res.text()).not.toContain('sprint_health');
    }
  });
});
