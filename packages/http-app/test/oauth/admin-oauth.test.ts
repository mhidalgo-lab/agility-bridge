// SPDX-License-Identifier: Apache-2.0
// Who may see and disconnect other people's connected apps, and who may revoke registered clients (P5-08, THREAT_MODEL
// T15, L-121): a full server with sign-in and real sessions, driven the way a browser drives it. Every refusal is a
// negative authorization test: the answer carries no data and the device or client is still usable afterwards.
import { describe, expect, it } from 'vitest';
import { ADMIN_BASE } from '../../src/index.ts';
import { setup } from '../helpers/panel.ts';

type T = Awaited<ReturnType<typeof setup>>;

const REDIRECT = 'http://127.0.0.1:53682/callback';
const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
const MCP = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
};
const WHOAMI = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } };
const HOSTILE = '<script>alert(1)</script><img src=x onerror=alert(2)>';

const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const random = (n = 32): string => b64u(crypto.getRandomValues(new Uint8Array(n)));

/** The workspace each access token was issued for. */
const slugOf = new Map<string, string>();

const server = () => setup({ oauth: { registrationIpLimit: 1000, registrationMaxClients: 500 } });

async function register(t: T, name: string): Promise<string> {
  const res = await t.send('POST', '/oauth/register', {
    site: null,
    body: {
      client_name: name,
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function login(t: T, email: string): Promise<{ cookie: string; csrf: string }> {
  const s = await t.session(email);
  return { cookie: s.cookie, csrf: s.csrf };
}

const attr = (html: string, name: string): string =>
  new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? '';

/** Everything the person does in a browser: authorize, Allow, exchange. Returns the tokens and the client. */
async function connect(
  t: T,
  who: { cookie: string },
  name: string,
  slug = 'team-a',
): Promise<{ access: string; refresh: string; clientId: string }> {
  const clientId = await register(t, name);
  const verifier = random(48);
  const challenge = b64u(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const path = `/oauth/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: 'mcp:read offline_access',
    state: `state-${random(8)}`,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${t.publicUrl}/w/${slug}/mcp`,
  })}`;
  const page = await t.send('GET', path, { site: 'cross-site', headers: NAV, cookie: who.cookie });
  const html = await page.text();
  const action = (/<form method="post" action="([^"]*)"/.exec(html)?.[1] ?? '').replaceAll('&amp;', '&');
  const grant = /name="grant" value="([^"]*)"/.exec(html)?.[1] ?? '';
  const res = await t.send('POST', action, {
    cookie: who.cookie,
    form: new URLSearchParams({
      _csrf: attr(html, '_csrf'),
      handle: attr(html, 'handle'),
      grant,
      decision: 'approve',
    }).toString(),
  });
  expect(res.status).toBe(303);
  const code = new URL(res.headers.get('location') as string).searchParams.get('code');
  expect(code).not.toBeNull();
  const tokens = await t.send('POST', '/oauth/token', {
    site: null,
    form: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code as string,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${t.publicUrl}/w/${slug}/mcp`,
    }).toString(),
  });
  expect(tokens.status).toBe(200);
  const json = (await tokens.json()) as { access_token: string; refresh_token: string };
  slugOf.set(json.access_token, slug);
  return { access: json.access_token, refresh: json.refresh_token, clientId };
}

const mcp = (t: T, slug: string, token: string): Promise<Response> =>
  t.send('POST', `/w/${slug}/mcp`, {
    site: null,
    headers: { ...MCP, host: t.host, authorization: `Bearer ${token}` },
    body: WHOAMI,
  });

const refresh = (t: T, clientId: string, token: string) =>
  t.send('POST', '/oauth/token', {
    site: null,
    form: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: clientId,
    }).toString(),
  });

/** A usable Agility credential and a grant on team-a for a person who has none in the test world. */
async function giveAccess(t: T, userId: string, token: string): Promise<void> {
  const cred = await t.w.services.credentials.create({
    instanceId: t.w.ids.instance,
    ownerUserId: userId,
    label: 'own',
    token,
  });
  await t.w.storage.credentials.update(cred.id, { validationStatus: 'valid' });
  await t.w.services.grants.create({ workspaceId: t.w.ids.workspaceA, userId, credentialId: cred.id });
}

interface DeviceRow {
  id: string;
  userId: string;
  userRole: string | null;
}

/** Everyone's devices as an owner reads them (the control for "what a refused caller must not have seen"). */
async function allDevices(t: T): Promise<DeviceRow[]> {
  const o = await login(t, 'owner@example.test');
  const res = await t.api('GET', '/oauth/devices?limit=50', o);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: DeviceRow[] }).data;
}

/** Four people, each with a connected app: a member (alice), another member (bob), an admin and an owner. */
async function world() {
  const t = await server();
  await giveAccess(t, t.w.ids.admin, '1.AdminAgilityTokenNotRealAbCdEfGh0008');
  await giveAccess(t, t.w.ids.owner, '1.OwnerAgilityTokenNotRealAbCdEfGh0009');
  const alice = await login(t, 'alice@example.test');
  const bob = await login(t, 'bob@example.test');
  const admin = await login(t, 'admin@example.test');
  const owner = await login(t, 'owner@example.test');
  const a = await connect(t, alice, HOSTILE);
  const b = await connect(t, bob, 'Bob app', 'team-b');
  const ad = await connect(t, admin, 'Admin app');
  const ow = await connect(t, owner, 'Owner app');
  const devices = await allDevices(t);
  const idOf = (userId: string) => (devices.find((d) => d.userId === userId) as DeviceRow).id;
  return {
    t,
    alice,
    bob,
    admin,
    owner,
    apps: { a, b, ad, ow },
    device: {
      alice: idOf(t.w.ids.alice),
      bob: idOf(t.w.ids.bob),
      admin: idOf(t.w.ids.admin),
      owner: idOf(t.w.ids.owner),
    },
  };
}

const works = async (t: T, token: string): Promise<boolean> =>
  (await mcp(t, slugOf.get(token) ?? 'team-a', token)).status === 200;

describe('connected apps of everyone and registered clients: who may do what (P5-08)', () => {
  it('a member sees nothing and ends nothing: every route is refused and every app keeps working', async () => {
    const w = await world();
    const { t, alice } = w;
    const before = await allDevices(t);
    for (const path of ['/oauth/devices', '/oauth/clients', '/oauth/abuse']) {
      const res = await t.api('GET', path, alice);
      expect(res.status, path).toBe(403);
      const text = await res.text();
      // No data: not a client name, a person or a device id.
      expect(text).not.toContain('Bob app');
      expect(text).not.toContain(w.device.bob);
    }
    // Her own device through the administrators' route, someone else's, a client, a restore: refused, nothing changes.
    for (const [path, body] of [
      [`/oauth/devices/${w.device.alice}/revoke`, { userId: t.w.ids.alice }],
      [`/oauth/devices/${w.device.bob}/revoke`, { userId: t.w.ids.bob }],
      ['/oauth/clients/revoke', { clientId: w.apps.b.clientId }],
      ['/oauth/clients/restore', { clientId: w.apps.b.clientId }],
    ] as const) {
      expect((await t.api('POST', path, alice, body)).status, path).toBe(403);
    }
    for (const token of [w.apps.a.access, w.apps.b.access, w.apps.ad.access, w.apps.ow.access]) {
      expect(await works(t, token)).toBe(true);
    }
    expect(await allDevices(t)).toEqual(before);
    // The refusals are audited as denied, with the actor's role and no token.
    const denied = (await t.rows()).filter((r) => r.action.startsWith('oauth_') && r.status === 'denied');
    expect(denied.length).toBeGreaterThanOrEqual(4);
  });

  it('a caller who is not signed in gets 401 from every route and changes nothing', async () => {
    const w = await world();
    const { t } = w;
    for (const [method, path, body] of [
      ['GET', '/oauth/devices', undefined],
      ['GET', '/oauth/clients', undefined],
      ['GET', '/oauth/abuse', undefined],
      ['POST', `/oauth/devices/${w.device.alice}/revoke`, { userId: t.w.ids.alice }],
      ['POST', '/oauth/clients/revoke', { clientId: w.apps.a.clientId }],
      ['POST', '/oauth/clients/restore', { clientId: w.apps.a.clientId }],
    ] as const) {
      const res = await t.send(method, `${ADMIN_BASE}${path}`, body === undefined ? {} : { body });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect(await works(t, w.apps.a.access)).toBe(true);
  });

  it("an admin sees everyone and ends a member's app, but not an owner's, another admin's or any client", async () => {
    const w = await world();
    const { t, admin } = w;
    const list = await t.api('GET', '/oauth/devices?limit=50', admin);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(4);
    // The owner's device: refused, still connected.
    const owner = await t.api('POST', `/oauth/devices/${w.device.owner}/revoke`, admin, {
      userId: t.w.ids.owner,
    });
    expect(owner.status).toBe(403);
    expect(await works(t, w.apps.ow.access)).toBe(true);
    // Clients are the owners'.
    expect((await t.api('GET', '/oauth/clients', admin)).status).toBe(403);
    // The abuse view is the owners' too (P5-20).
    const abuse = await t.api('GET', '/oauth/abuse', admin);
    expect(abuse.status).toBe(403);
    expect(await abuse.text()).not.toContain('refusals');
    expect(
      (await t.api('POST', '/oauth/clients/revoke', admin, { clientId: w.apps.a.clientId })).status,
    ).toBe(403);
    expect(await works(t, w.apps.a.access)).toBe(true);
    // A member's device: ended, at once, refresh included. Bob's is untouched.
    const ok = await t.api('POST', `/oauth/devices/${w.device.alice}/revoke`, admin, {
      userId: t.w.ids.alice,
    });
    expect(ok.status).toBe(200);
    expect(await works(t, w.apps.a.access)).toBe(false);
    expect((await refresh(t, w.apps.a.clientId, w.apps.a.refresh)).status).toBe(400);
    expect(await works(t, w.apps.b.access)).toBe(true);
    // An admin may end their own.
    expect(
      (await t.api('POST', `/oauth/devices/${w.device.admin}/revoke`, admin, { userId: t.w.ids.admin }))
        .status,
    ).toBe(200);
    expect(await works(t, w.apps.ad.access)).toBe(false);
  });

  it("an owner ends anyone's app and revokes a client, with the audit rows of the owner", async () => {
    const w = await world();
    const { t, owner } = w;
    expect(
      (await t.api('POST', `/oauth/devices/${w.device.admin}/revoke`, owner, { userId: t.w.ids.admin }))
        .status,
    ).toBe(200);
    expect(await works(t, w.apps.ad.access)).toBe(false);
    const clients = (await (await t.api('GET', '/oauth/clients', owner)).json()) as {
      data: { clientId: string; devices: number }[];
    };
    expect(clients.data.map((c) => c.clientId)).toContain(w.apps.b.clientId);
    const res = await t.api('POST', '/oauth/clients/revoke', owner, { clientId: w.apps.b.clientId });
    expect(res.status).toBe(200);
    expect(await works(t, w.apps.b.access)).toBe(false);
    expect((await refresh(t, w.apps.b.clientId, w.apps.b.refresh)).status).toBe(400);
    expect(await works(t, w.apps.a.access)).toBe(true);
    const rows = await t.rows();
    const mine = rows.filter((r) => r.action === 'oauth_client.revoke' || r.action === 'oauth_device.revoke');
    expect(mine.map((r) => r.userId)).toEqual(expect.arrayContaining([t.w.ids.owner]));
    expect(JSON.stringify(rows)).not.toContain(w.apps.b.refresh);
    expect(JSON.stringify(rows)).not.toContain(w.apps.b.access);
  });

  it("a device under another person's id is not found, and the right person's device is not harmed", async () => {
    const w = await world();
    const { t, owner } = w;
    const res = await t.api('POST', `/oauth/devices/${w.device.alice}/revoke`, owner, {
      userId: t.w.ids.bob,
    });
    expect(res.status).toBe(404);
    expect(await works(t, w.apps.a.access)).toBe(true);
  });

  it("revoking is a POST with the panel's protections: no CSRF token, a cross-site post and a GET change nothing", async () => {
    const w = await world();
    const { t, owner } = w;
    const path = `${ADMIN_BASE}/oauth/devices/${w.device.alice}/revoke`;
    const body = { userId: t.w.ids.alice };
    // No CSRF token.
    expect((await t.send('POST', path, { cookie: owner.cookie, body })).status).toBe(403);
    // A wrong one.
    expect(
      (
        await t.send('POST', path, {
          cookie: owner.cookie,
          body,
          headers: { 'x-csrf-token': 'x'.repeat(40) },
        })
      ).status,
    ).toBe(403);
    // From another site, with the right token.
    expect(
      (
        await t.send('POST', path, {
          cookie: owner.cookie,
          body,
          site: 'cross-site',
          headers: { 'x-csrf-token': owner.csrf },
        })
      ).status,
    ).toBe(403);
    // A GET never revokes (L-090).
    expect((await t.send('GET', path, { cookie: owner.cookie })).status).toBeGreaterThanOrEqual(400);
    expect(
      (await t.send('GET', `${ADMIN_BASE}/oauth/clients/revoke`, { cookie: owner.cookie })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(await works(t, w.apps.a.access)).toBe(true);
    // The same on the panel's pages.
    for (const page of [`/admin/oauth/devices/${w.device.alice}/revoke`, '/admin/oauth/clients/revoke']) {
      const res = await t.send('GET', page, { cookie: owner.cookie });
      expect(res.status, page).toBeGreaterThanOrEqual(400);
    }
    expect(await works(t, w.apps.a.access)).toBe(true);
  });

  it('the panel pages show hostile names inert, offer Disconnect only where the role allows it, and refuse other roles', async () => {
    const w = await world();
    const { t } = w;
    const page = async (who: { cookie: string }, path: string) => {
      const res = await t.send('GET', path, { cookie: who.cookie });
      return { status: res.status, html: await res.text() };
    };
    const asOwner = await page(w.owner, '/admin/oauth/devices');
    expect(asOwner.status).toBe(200);
    // The name is text, never markup.
    expect(asOwner.html).not.toContain('<script>alert(1)</script>');
    expect(asOwner.html).not.toContain('<img src=x');
    expect(asOwner.html).toContain('&lt;script&gt;');
    // The owner may end all four.
    expect(asOwner.html.match(/action="\/admin\/oauth\/devices\/[A-Za-z0-9_-]{16}\/revoke"/g)).toHaveLength(
      4,
    );
    const asAdmin = await page(w.admin, '/admin/oauth/devices');
    expect(asAdmin.status).toBe(200);
    // An admin may end members' and their own: three of four.
    expect(asAdmin.html.match(/action="\/admin\/oauth\/devices\/[A-Za-z0-9_-]{16}\/revoke"/g)).toHaveLength(
      3,
    );
    // Members and admins get no clients page; members no devices page.
    expect((await page(w.admin, '/admin/oauth/clients')).status).toBe(403);
    expect((await page(w.alice, '/admin/oauth/clients')).status).toBe(403);
    const memberDevices = await page(w.alice, '/admin/oauth/devices');
    expect(memberDevices.status).toBe(403);
    expect(memberDevices.html).not.toContain('Bob app');
    const clients = await page(w.owner, '/admin/oauth/clients');
    expect(clients.status).toBe(200);
    expect(clients.html).not.toContain('<script>alert(1)</script>');
    expect(clients.html).toContain('not verified');
    expect(clients.html).toContain('127.0.0.1:53682');
    // The navigation follows the role.
    const nav = (html: string) => [
      html.includes('href="/admin/oauth/devices"'),
      html.includes('href="/admin/oauth/clients"'),
    ];
    expect(nav(asOwner.html)).toEqual([true, true]);
    expect(nav(asAdmin.html)).toEqual([true, false]);
    expect(nav((await page(w.alice, '/admin/me')).html)).toEqual([false, false]);
  });

  it('the panel forms end the device and the client, and a member posting to them changes nothing', async () => {
    const w = await world();
    const { t } = w;
    const csrfOf = (html: string) => attr(html, '_csrf');
    // A member posts the owner's form fields with the member's own session and CSRF token: refused.
    const memberPost = await t.send('POST', `/admin/oauth/devices/${w.device.bob}/revoke`, {
      cookie: w.alice.cookie,
      form: new URLSearchParams({ _csrf: w.alice.csrf, userId: t.w.ids.bob }).toString(),
    });
    expect(memberPost.status).toBeGreaterThanOrEqual(300);
    expect(await works(t, w.apps.b.access)).toBe(true);
    const memberClient = await t.send('POST', '/admin/oauth/clients/revoke', {
      cookie: w.alice.cookie,
      form: new URLSearchParams({ _csrf: w.alice.csrf, clientId: w.apps.b.clientId }).toString(),
    });
    expect(memberClient.status).toBeGreaterThanOrEqual(300);
    expect(await works(t, w.apps.b.access)).toBe(true);
    // The owner's forms.
    const devices = await (await t.send('GET', '/admin/oauth/devices', { cookie: w.owner.cookie })).text();
    const csrf = csrfOf(devices);
    expect(csrf).not.toBe('');
    const ended = await t.send('POST', `/admin/oauth/devices/${w.device.bob}/revoke`, {
      cookie: w.owner.cookie,
      form: new URLSearchParams({ _csrf: csrf, userId: t.w.ids.bob }).toString(),
    });
    expect(ended.status).toBe(303);
    expect(await works(t, w.apps.b.access)).toBe(false);
    const gone = await t.send('POST', '/admin/oauth/clients/revoke', {
      cookie: w.owner.cookie,
      form: new URLSearchParams({ _csrf: csrf, clientId: w.apps.a.clientId }).toString(),
    });
    expect(gone.status).toBe(303);
    expect(await works(t, w.apps.a.access)).toBe(false);
    expect(await works(t, w.apps.ow.access)).toBe(true);
    const after = await (await t.send('GET', '/admin/oauth/clients', { cookie: w.owner.cookie })).text();
    expect(after).toContain('Revoked apps');
    expect(after).not.toContain('<script>alert(1)</script>');
  });

  it('another workspace is not a boundary of its own: an admin is an admin of every workspace, and OAuth off is a 404', async () => {
    // Roles here are server-wide (ADR-0008): the check is the role, not the workspace of the device.
    const w = await world();
    const { t } = w;
    const onB = await connect(t, w.alice, 'App on B', 'team-b');
    expect(onB.clientId).not.toBe('');
    const devices = await allDevices(t);
    const second = devices.find((d) => d.userId === t.w.ids.alice && d.id !== w.device.alice) as DeviceRow;
    expect(
      (await t.api('POST', `/oauth/devices/${second.id}/revoke`, w.admin, { userId: t.w.ids.alice })).status,
    ).toBe(200);
    expect((await mcp(t, 'team-b', onB.access)).status).toBe(401);
    // Without OAuth the routes answer 404 (after the role check, so a refused caller learns nothing).
    const off = await setup();
    const o = await login(off, 'owner@example.test');
    expect((await off.api('GET', '/oauth/devices', o)).status).toBe(404);
    expect((await off.api('GET', '/oauth/clients', o)).status).toBe(404);
    const a = await login(off, 'alice@example.test');
    expect((await off.api('GET', '/oauth/devices', a)).status).toBe(403);
  });
});

describe('the operator view of OAuth abuse controls (P5-20)', () => {
  it('an owner sees the caps and the limits on the API and on the OAuth apps page, with nothing that names a caller', async () => {
    const w = await world();
    const { t, owner } = w;
    const res = await t.api('GET', '/oauth/abuse', owner);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      registrations: { dynamic: { enabled: true }, documents: { cap: 200 } },
      windowHours: 24,
    });
    expect(text).not.toMatch(/usr_|@example|oauth_/);
    const page = await t.send('GET', '/admin/oauth/clients', { cookie: owner.cookie });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Limits and caps');
    expect(html).toContain('Registration caps');
    expect(html).toContain('authorizeIp=');
  });

  it('members and administrators get no page data either', async () => {
    const w = await world();
    for (const who of [w.alice, w.admin]) {
      const page = await w.t.send('GET', '/admin/oauth/clients', { cookie: who.cookie });
      expect(page.status).toBe(403);
      expect(await page.text()).not.toContain('Limits and caps');
    }
  });
});
