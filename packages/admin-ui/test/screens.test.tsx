// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// The P4-04 screens against a fake admin API (THREAT_MODEL T8, T13): what each screen asks the API for, what it sends, how
// it shows refusals (fixed text, never an error body's words except a validation sentence), that a typed secret leaves in
// exactly one place, and the single-use handle behind the one-time token page. The real API, roles and storage are
// exercised in `packages/http-app/test/admin-screens.test.ts`.
import { describe, expect, it } from 'vitest';
import { TextField } from '../src/components.tsx';
import { createUiKit, ONCE_FIELD, ONCE_MAX_OUTSTANDING } from '../src/kit.ts';
import { renderDocument } from '../src/pages.tsx';
import {
  assetTypesFrom,
  formMessage,
  limitFieldOf,
  limitsFrom,
  paged,
  problemOf,
  toolsFrom,
  wholeNumber,
  withQuery,
  words,
} from '../src/screens/shared.tsx';
import { CSRF, type Fake, fakeDeps, get, post } from './helpers/fake-deps.ts';

const asAdmin = { 'x-test-session': 'admin' };
const asOwner = { 'x-test-session': 'owner' };
const asMember = { 'x-test-session': 'member' };
const TOKEN = `1.${'abcdef0123456789'.repeat(3)}`;
const HOSTILE = '<img src=x onerror=alert(1)>"\'';

const instance = (over: Record<string, unknown> = {}) => ({
  id: 'ins_1',
  label: 'Production',
  baseUrl: 'https://agility.example.test/acme',
  tls: null,
  numberPrefixes: null,
  metaFingerprint: null,
  createdAt: 1,
  updatedAt: 1,
  disabledAt: null,
  ...over,
});
const credential = (over: Record<string, unknown> = {}) => ({
  id: 'crd_1',
  instanceId: 'ins_1',
  ownerUserId: null,
  label: 'Team token',
  tokenHint: 'ab12',
  validationStatus: 'valid',
  validationErrorCode: null,
  validatedAt: 5,
  memberName: null,
  memberUsername: null,
  reachableScopeIds: ['Scope:1'],
  createdAt: 1,
  updatedAt: 1,
  revokedAt: null,
  ...over,
});
const err = (status: number, code: string, message = 'x', extra: Record<string, unknown> = {}) => ({
  status,
  body: { error: { code, message, ...extra } },
});

/** Routes the fake API by `METHOD path`. */
function api(f: Fake, routes: Record<string, unknown | ((body: unknown) => unknown)>) {
  f.respond = (call) => {
    const key = `${call.method} ${call.path}`;
    const hit = routes[key];
    if (hit === undefined) return { status: 404, body: { error: { code: 'not_found', message: 'no' } } };
    const answer = typeof hit === 'function' ? (hit as (b: unknown) => unknown)(call.body) : hit;
    return typeof answer === 'object' && answer !== null && 'status' in answer
      ? (answer as { status: number; body: unknown })
      : { status: 200, body: answer };
  };
}
const bodies = (f: Fake, key: string) =>
  f.calls.filter((c) => `${c.method} ${c.path}` === key).map((c) => c.body);

describe('shared form helpers', () => {
  it('pages lists, keeps the filter in the links and treats a bad page as the first or last', () => {
    const all = Array.from({ length: 60 }, (_, i) => i);
    expect(paged(all, undefined, '/x').rows).toHaveLength(25);
    expect(paged(all, '2', '/x', { f: 'a' })).toMatchObject({ prev: '/x?f=a', next: '/x?f=a&page=3' });
    expect(paged(all, '3', '/x').rows).toEqual(all.slice(50));
    expect(paged(all, '3', '/x').next).toBeNull();
    for (const bad of ['0', '-1', 'abc', '1.5', '', '99999999999999999'])
      expect(paged(all, bad, '/x').rows[0], bad).toBe(0);
    expect(paged(all, '999', '/x').rows[0]).toBe(50);
    expect(paged([], undefined, '/x')).toEqual({ rows: [], prev: null, next: null });
    expect(withQuery('/x', { a: '', b: undefined, c: 'd e' })).toBe('/x?c=d+e');
  });

  it('reads limits, tools and asset types, reporting what is wrong beside the field', () => {
    const f = (o: Record<string, string | string[]>) => ({
      fields: new URLSearchParams(
        Object.entries(o).flatMap(([k, v]) =>
          (Array.isArray(v) ? v : [v]).map((x) => [k, x] as [string, string]),
        ),
      ),
    });
    expect(limitsFrom(f({ limit_maxRows: '50', limit_memberEmails: 'off' }))).toEqual({
      limits: { maxRows: 50, memberEmails: false },
    });
    expect(limitsFrom(f({ limit_maxRows: '0', limit_maxFields: 'x', limit_genericQuery: 'maybe' }))).toEqual({
      errors: {
        limit_maxRows: 'Enter a whole number from 1 to 1000, or leave it blank.',
        limit_maxFields: 'Enter a whole number from 1 to 200, or leave it blank.',
        limit_genericQuery: 'Choose one of the options.',
      },
    });
    expect(limitsFrom(f({ limit_maxNestingDepth: '0' }))).toEqual({ limits: { maxNestingDepth: 0 } });
    expect(wholeNumber(f({ n: ' 12 ' }), 'n', 1, 20)).toBe(12);
    expect(wholeNumber(f({ n: '1e3' }), 'n', 1, 2000)).toBeNull();
    expect(wholeNumber(f({}), 'n', 1, 20)).toBeUndefined();
    const tools = [
      { name: 'whoami', kind: 'read', group: 'a' },
      { name: 'get_assets', kind: 'read', group: 'a' },
      { name: 'update_work_item', kind: 'write', group: 'b' },
    ] as const;
    expect(toolsFrom(f({ tools_all: '1' }), tools)).toEqual({ value: null });
    expect(toolsFrom(f({ tools_all: '1', tools: 'update_work_item' }), tools)).toEqual({
      value: ['whoami', 'get_assets', 'update_work_item'],
    });
    expect(toolsFrom(f({ tools: ['whoami', 'whoami', '../x', 'UPPER'] }), tools)).toEqual({
      value: ['whoami'],
    });
    expect(toolsFrom(f({}), tools)).toEqual({ error: 'Choose at least one tool, or all tools.' });
    expect(assetTypesFrom(f({}))).toEqual({ value: null });
    expect(assetTypesFrom(f({ types_allow: 'Story, Defect Story', types_deny: 'Task' }))).toEqual({
      value: { allow: ['Story', 'Defect'], deny: ['Task'] },
    });
    expect(assetTypesFrom(f({ types_allow: 'Story;DROP' }))).toHaveProperty('errors.types_allow');
    expect(words(' a,b  c,,a ')).toEqual(['a', 'b', 'c']);
    expect(limitFieldOf('limits.maxRows')).toBe('limit_maxRows');
    expect(limitFieldOf('workspace.limits.callBudget')).toBe('limit_callBudget');
    expect(limitFieldOf('name')).toBeUndefined();
  });

  it('shows only a validation sentence from an error body; everything else is fixed text', () => {
    const body = (status: number, code: string, message: string) =>
      problemOf({ status, body: { error: { code, message } } });
    expect(formMessage(body(422, 'invalid_input', 'name: must not be empty.'))).toBe(
      'name: must not be empty.',
    );
    expect(formMessage(body(422, 'invalid_input', 'x'.repeat(1000)))).toHaveLength(300);
    for (const [status, code] of [
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'conflict'],
      [502, 'upstream'],
      [503, 'unavailable'],
      [500, 'internal'],
    ] as const) {
      const text = formMessage(body(status, code, `secret ${HOSTILE} detail`));
      expect(text, `${status}`).not.toContain('secret');
      expect(text, `${status}`).not.toContain('<');
    }
    expect(problemOf({ status: 500, body: null })).toMatchObject({ code: 'internal', field: undefined });
  });
});

describe('a password field never carries a value', () => {
  it('ignores the value it is given and switches autocomplete, spellcheck and capitalisation off', () => {
    const html = renderDocument(
      <TextField
        name="token"
        label="Token"
        type="password"
        value="hunter2-secret"
        autocomplete="on"
        spellcheck
      />,
    );
    expect(html).not.toContain('hunter2-secret');
    expect(html).not.toMatch(/value=/);
    expect(html).toContain('type="password"');
    expect(html).toContain('autocomplete="off"');
    expect(html).toContain('spellcheck="false"');
    expect(html).toContain('autocapitalize="off"');
  });
});

describe('single-use form handles', () => {
  const principal = (userId = 'u1') => ({ userId }) as never;
  const setup = (f: Fake = fakeDeps()) => ({ f, kit: createUiKit(f.deps) });

  it('writes a handle per issue, up to the cap, then hands out open ones', async () => {
    const { f, kit } = setup();
    const p = principal();
    const made = new Set<string>();
    for (let i = 0; i < ONCE_MAX_OUTSTANDING; i++) made.add(await kit.issueOnce(p));
    expect(f.once.size).toBe(ONCE_MAX_OUTSTANDING);
    for (let i = 0; i < 40; i++) {
      const h = await kit.issueOnce(p);
      expect(made.has(h)).toBe(true);
    }
    expect(f.once.size).toBe(ONCE_MAX_OUTSTANDING);
    // Another user has their own allowance.
    await kit.issueOnce(principal('u2'));
    expect(f.once.size).toBe(ONCE_MAX_OUTSTANDING + 1);
  });

  it('takes a handle once, only for the user it was issued to, and only from a verified form', async () => {
    const f = fakeDeps();
    let handle = '';
    const kit = createUiKit(f.deps);
    const { Hono } = await import('hono');
    const app = new Hono();
    const results: boolean[] = [];
    app.get(
      '/issue',
      kit.page('member', async (_c, page) => new Response(await kit.issueOnce(page.principal))),
    );
    app.post(
      '/claim',
      kit.form('member', async (_c, _p, form) => {
        results.push(await kit.claimOnce(form));
        return new Response('ok');
      }),
    );
    handle = await (
      await app.request('/issue', { headers: { ...asMember, 'sec-fetch-site': 'same-origin' } })
    ).text();
    const send = (who: Record<string, string>, body: string) =>
      app.request('/claim', {
        method: 'POST',
        headers: {
          ...who,
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
          origin: 'http://127.0.0.1:8787',
        },
        body,
      });
    const ok = `_csrf=${CSRF}&${ONCE_FIELD}=${handle}`;
    // The other user's session id differs: `member` is `usr_member`, `admin` is `usr_admin`.
    await send(asAdmin, ok);
    await send(asMember, `_csrf=${CSRF}`);
    await send(asMember, `${ok}&${ONCE_FIELD}=${handle}`);
    await send(asMember, `_csrf=${CSRF}&${ONCE_FIELD}=${'B'.repeat(22)}`);
    expect(results).toEqual([false, false, false, false]);
    await send(asMember, ok);
    await send(asMember, ok);
    expect(results.slice(4)).toEqual([true, false]);
  });

  it('writes nothing for HEAD', async () => {
    const f = fakeDeps();
    api(f, {
      'GET /grants/grt_1': {
        id: 'grt_1',
        workspaceId: 'wsp_1',
        userId: null,
        label: 'ci',
        credentialId: null,
        limits: {},
        createdAt: 1,
        expiresAt: null,
        revokedAt: null,
      },
      'GET /workspaces/wsp_1': { id: 'wsp_1', slug: 't', name: 'T', instanceId: 'ins_1' },
    });
    const head = await f.app.request('/admin/grants/grt_1/tokens/new', {
      method: 'HEAD',
      headers: { ...asAdmin, 'sec-fetch-site': 'same-origin' },
    });
    expect(head.status).toBe(200);
    expect(f.once.size).toBe(0);
    const res = await get(f, '/admin/grants/grt_1/tokens/new', asAdmin);
    expect(res.status).toBe(200);
    expect(f.once.size).toBe(1);
  });
});

describe('instances screen', () => {
  it('lists through the admin API with the label escaped, and offers owner-only controls to owners only', async () => {
    const f = fakeDeps();
    api(f, {
      'GET /instances': [instance({ label: HOSTILE })],
      'GET /instances/ins_1': instance({ label: HOSTILE }),
      'GET /credentials': [credential()],
      'GET /workspaces': [],
    });
    const list = await (await get(f, '/admin/instances', asAdmin)).text();
    expect(list).not.toContain('<img src=x');
    expect(list).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const adminDetail = await (await get(f, '/admin/instances/ins_1', asAdmin)).text();
    expect(adminDetail).not.toContain('Change the origin…');
    const ownerDetail = await (await get(f, '/admin/instances/ins_1', asOwner)).text();
    expect(ownerDetail).toContain('Change the origin…');
    expect((await get(f, '/admin/instances/ins_1/origin', asAdmin)).status).toBe(403);
    expect((await get(f, '/admin/instances/ins_1/origin', asMember)).status).toBe(403);
    expect((await get(f, '/admin/instances', asMember)).status).toBe(403);
    expect(f.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('sends the typed fields to the API and shows a validation sentence beside the form', async () => {
    const f = fakeDeps();
    api(f, {
      'POST /instances': (body: unknown) =>
        (body as { baseUrl: string }).baseUrl === 'bad'
          ? err(422, 'invalid_input', 'baseUrl: not an https address.', { field: 'baseUrl' })
          : { status: 201, body: instance({ id: 'ins_9' }) },
    });
    const ok = await post(
      f,
      '/admin/instances',
      { _csrf: CSRF, label: ' Staging ', baseUrl: 'https://x.example.test' },
      asAdmin,
    );
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/admin/instances/ins_9');
    expect(bodies(f, 'POST /instances')).toEqual([{ label: 'Staging', baseUrl: 'https://x.example.test' }]);
    const bad = await post(f, '/admin/instances', { _csrf: CSRF, label: 'Keep me', baseUrl: 'bad' }, asAdmin);
    const html = await bad.text();
    expect(bad.status).toBe(422);
    expect(html).toContain('baseUrl: not an https address.');
    expect(html).toContain('value="Keep me"');
    // An admin cannot send a CA file at all: refused before the API is called.
    const ca = await post(
      f,
      '/admin/instances',
      { _csrf: CSRF, label: 'x', baseUrl: 'https://y.example.test', caFile: '/etc/ca.pem' },
      asAdmin,
    );
    expect(ca.status).toBe(422);
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('shows a hostile error message from the API as fixed text', async () => {
    const f = fakeDeps();
    api(f, { 'POST /instances': err(502, 'upstream', `Agility said ${HOSTILE} <script>alert(1)</script>`) });
    const res = await post(
      f,
      '/admin/instances',
      { _csrf: CSRF, label: 'x', baseUrl: 'https://z.example.test' },
      asOwner,
    );
    const html = await res.text();
    expect(html).not.toContain('Agility said');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('did not answer like an Agility site');
  });
});

describe('credentials screen', () => {
  it('sends the typed token to the API once and never puts it in a response, a redirect or a cookie', async () => {
    const f = fakeDeps();
    api(f, {
      'GET /instances': [instance()],
      'GET /users': [],
      'POST /credentials': (body: unknown) =>
        (body as { token: string }).token.includes(' ')
          ? err(422, 'invalid_input', 'The Agility access token must be a single line without spaces.', {
              field: 'token',
            })
          : { status: 201, body: credential({ id: 'crd_9' }) },
    });
    const ok = await post(
      f,
      '/admin/credentials',
      { _csrf: CSRF, instanceId: 'ins_1', scope: 'mine', label: 'Mine', token: TOKEN },
      asAdmin,
    );
    expect(ok.status).toBe(303);
    expect(
      [ok.headers.get('location'), ...ok.headers.getSetCookie(), await ok.text()].join('\n'),
    ).not.toContain(TOKEN);
    expect(bodies(f, 'POST /credentials')).toEqual([
      { instanceId: 'ins_1', ownerUserId: 'usr_admin', label: 'Mine', token: TOKEN },
    ]);
    const spaced = `${TOKEN} ${TOKEN}`;
    const bad = await post(
      f,
      '/admin/credentials',
      { _csrf: CSRF, instanceId: 'ins_1', scope: 'shared', label: 'Keep', token: spaced },
      asAdmin,
    );
    const html = await bad.text();
    expect(bad.status).toBe(422);
    expect(html).toContain('single line without spaces');
    expect(html).not.toContain(TOKEN);
    expect(html).toContain('value="Keep"');
    expect(html).not.toMatch(/<input[^>]*type="password"[^>]*value=/);
    // A client-side failure (no label) echoes nothing either.
    const nolabel = await post(
      f,
      '/admin/credentials',
      { _csrf: CSRF, instanceId: 'ins_1', scope: 'shared', label: '', token: TOKEN },
      asAdmin,
    );
    expect(nolabel.status).toBe(422);
    expect(await nolabel.text()).not.toContain(TOKEN);
  });

  it('turns reauth_required into the sign-in-again page and changes nothing', async () => {
    const f = fakeDeps();
    api(f, {
      'GET /credentials/crd_1': credential(),
      'POST /credentials/crd_1/token': err(
        403,
        'reauth_required',
        "Sign in again before replacing a credential's token.",
      ),
    });
    const res = await post(f, '/admin/credentials/crd_1/token', { _csrf: CSRF, token: TOKEN }, asOwner);
    const html = await res.text();
    expect(res.status).toBe(403);
    expect(html).toContain('/auth/reauth?next=%2Fadmin%2Fcredentials%2Fcrd_1%2Ftoken');
    expect(html).toContain('Nothing was changed');
    expect(html).not.toContain(TOKEN);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("offers no token replacement for another person's personal credential", async () => {
    const f = fakeDeps();
    api(f, {
      'GET /credentials/crd_2': credential({ id: 'crd_2', ownerUserId: 'usr_someone' }),
      'GET /credentials/crd_3': credential({ id: 'crd_3', ownerUserId: 'usr_admin' }),
      'GET /instances': [instance()],
      'GET /users': [],
    });
    expect(await (await get(f, '/admin/credentials/crd_2', asAdmin)).text()).not.toContain(
      'Replace the token…',
    );
    expect((await get(f, '/admin/credentials/crd_2/token', asAdmin)).status).toBe(404);
    expect(await (await get(f, '/admin/credentials/crd_3', asAdmin)).text()).toContain('Replace the token…');
    expect((await get(f, '/admin/credentials/crd_3/token', asAdmin)).status).toBe(200);
  });
});

describe('users screen', () => {
  const user = (id: string, role: string, over: Record<string, unknown> = {}) => ({
    id,
    email: `${id}@example.test`,
    displayName: null,
    idp: null,
    idpSubject: null,
    role,
    createdAt: 1,
    updatedAt: 1,
    disabledAt: null,
    ...over,
  });

  it('turns a last-owner refusal into its own message and nothing else', async () => {
    const f = fakeDeps();
    api(f, {
      'PATCH /users/usr_owner': err(403, 'forbidden', 'The last active owner cannot lose the owner role.', {
        detail: 'last_owner',
      }),
    });
    const res = await post(f, '/admin/users/usr_owner/role', { _csrf: CSRF, role: 'member' }, asOwner);
    expect(res.status).toBe(303);
    expect(res.headers.getSetCookie().join(';')).toContain('ab_flash=last_owner');
    expect(res.headers.get('location')).toBe('/admin/users/usr_owner');
  });

  it('sends only what changed, so an unchanged owner needs no recent sign-in', async () => {
    const f = fakeDeps();
    api(f, {
      'GET /users/usr_t': user('usr_t', 'owner', { displayName: 'T' }),
      'PATCH /users/usr_t': user('usr_t', 'owner'),
    });
    const same = await post(
      f,
      '/admin/users/usr_t',
      { _csrf: CSRF, email: 'usr_t@example.test', displayName: 'T' },
      asOwner,
    );
    expect(same.status).toBe(303);
    expect(bodies(f, 'PATCH /users/usr_t')).toEqual([]);
    await post(
      f,
      '/admin/users/usr_t',
      { _csrf: CSRF, email: 'usr_t@example.test', displayName: 'New' },
      asOwner,
    );
    expect(bodies(f, 'PATCH /users/usr_t')).toEqual([{ displayName: 'New' }]);
  });

  it('shows admins no controls on owners and admins, and owners all of them', async () => {
    const f = fakeDeps();
    api(f, {
      'GET /users/usr_o': user('usr_o', 'owner'),
      'GET /users/usr_a': user('usr_a', 'admin'),
      'GET /users/usr_m': user('usr_m', 'member'),
    });
    for (const [id, adminSees] of [
      ['usr_o', false],
      ['usr_a', false],
      ['usr_m', true],
    ] as const) {
      const asA = await (await get(f, `/admin/users/${id}`, asAdmin)).text();
      expect(asA.includes('aria-label="Edit the person"'), `admin ${id}`).toBe(adminSees);
      expect(asA.includes('Disable…'), `admin ${id}`).toBe(adminSees);
      expect(asA).not.toContain('aria-label="Change the role"');
      const asO = await (await get(f, `/admin/users/${id}`, asOwner)).text();
      expect(asO).toContain('aria-label="Edit the person"');
      expect(asO).toContain('aria-label="Change the role"');
    }
  });
});
