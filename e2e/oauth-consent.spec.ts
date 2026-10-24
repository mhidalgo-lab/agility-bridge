// SPDX-License-Identifier: Apache-2.0
// P5-04: sign-in and consent for an OAuth client in a real Chromium, at 1280 px and at 320 px, against the built
// `agility-bridge serve` with `AB_OAUTH=on`, a fake identity provider and the synthetic Agility. The client is a script
// (dynamic registration, PKCE, code exchange); the person is the browser: signed out, the authorization request goes
// through sign-in and back to the consent page, Allow returns the code to a loopback redirect, the token reaches the MCP
// endpoint, and Disconnect on "My access" ends it. Every page load is watched for CSP violations (the redirect after the
// post is subject to `form-action`), console errors and uncaught errors.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { expect, type Page, test } from '@playwright/test';
import { expectAccessible, expectNoHorizontalScroll, visit } from './helpers.ts';
import { OWNER, startServer, type TestServer } from './server.ts';
import { watch } from './watch.ts';

test.describe.configure({ mode: 'serial' });

let server: TestServer;
/** The access token the second test obtains, for the last test to disconnect. */
let connectedAccess = '';
const SLUG = 'synthetic';
const CALLBACK = 'http://127.0.0.1:53999/callback';
const WHOAMI = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } };

test.beforeAll(async () => {
  server = await startServer({ env: { AB_OAUTH: 'on' } });
  app = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1:53999');
    res.writeHead(200, { 'content-type': 'text/plain' }).end('app');
    const next = waiting;
    waiting = [];
    for (const w of next) w(u);
  });
  await new Promise<void>((r) => app.listen(53999, '127.0.0.1', r));
});
test.afterAll(async () => {
  await new Promise<void>((r) => (app ? app.close(() => r()) : r()));
  await server?.stop();
});

const b64u = (b: Buffer): string => b.toString('base64url');

async function register(name: string): Promise<string> {
  const res = await fetch(`${server.base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function request(clientId: string) {
  const verifier = b64u(randomBytes(48));
  const state = b64u(randomBytes(8));
  const url = `${server.base}/oauth/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    scope: 'mcp:read offline_access',
    state,
    code_challenge: b64u(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    resource: `${server.base}/w/${SLUG}/mcp`,
  })}`;
  return { url, verifier, state };
}

/**
 * The client's redirect URI is answered by a real loopback listener (Chromium does not route redirect targets through
 * `page.route`), so the browser's navigation ends there and the test sees exactly what the app would.
 */
let app: Server;
let waiting: Array<(u: URL) => void> = [];
function catchCallback(page: Page, problems: readonly string[] = []): () => Promise<URL> {
  const seen = new Promise<URL>((resolve) => {
    waiting.push(resolve);
  });
  return () =>
    Promise.race([
      seen,
      new Promise<URL>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`the redirect never reached the app; at ${page.url()}; ${problems.join(' | ')}`),
            ),
          20_000,
        ),
      ),
    ]);
}

async function mcp(token: string): Promise<number> {
  const res = await fetch(`${server.base}/w/${SLUG}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(WHOAMI),
  });
  return res.status;
}

test('owner: setup, an instance, a workspace and a grant for the owner', async ({ page }) => {
  const w = await watch(page);
  await page.goto(await server.setupLink());
  await page.getByRole('button', { name: 'Continue with Corp SSO' }).click();
  await expect(page).toHaveURL(`${server.base}/admin`);
  const seeded = await server.seed(SLUG);
  const users = (await server.api('GET', '/users')).json as Array<{ id: string; email: string }>;
  const owner = users.find((u) => u.email === OWNER.email);
  expect(owner).toBeDefined();
  const grant = await server.api('POST', '/grants', {
    workspaceId: seeded.workspaceId,
    userId: owner?.id,
    label: 'Owner laptop',
  });
  expect(grant.status).toBe(201);
  w.assertClean();
});

test('a client sends the browser through sign-in to the consent page, and Allow returns the code', async ({
  page,
}) => {
  const w = await watch(page);
  const clientId = await register('Phone app');
  const r = request(clientId);
  const callback = catchCallback(page, w.problems);

  await test.step('signed out, the request goes through sign-in and comes back to the consent page', async () => {
    // Not signed in: the owner's session from the first test lives in another browser context.
    await page.goto(r.url);
    await expect(page).toHaveURL(/\/auth\/login\?next=/);
    await page.getByRole('link', { name: 'Continue with Corp SSO' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Connect an app' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/oauth/authorize');
  });

  await test.step('the page names the app, where it sends you and the workspace; it fits and is accessible', async () => {
    await expect(page.getByText('Phone app').first()).toBeVisible();
    await expect(page.getByText('not verified')).toBeVisible();
    await expect(page.getByText('127.0.0.1:53999').first()).toBeVisible();
    await expect(page.getByText('Synthetic workspace')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page);
  });

  await test.step('Allow hands the code to the redirect address, with state and iss', async () => {
    await page.getByLabel('Device name (optional)').fill('E2E browser');
    await page.getByRole('button', { name: 'Allow' }).click();
    const back = await callback();
    expect(back.searchParams.get('state')).toBe(r.state);
    expect(back.searchParams.get('iss')).toBe(server.base);
    const code = back.searchParams.get('code') ?? '';
    expect(code).not.toBe('');
    const tokens = await fetch(`${server.base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: CALLBACK,
        client_id: clientId,
        code_verifier: r.verifier,
        resource: `${server.base}/w/${SLUG}/mcp`,
      }),
    });
    expect(tokens.status).toBe(200);
    const access = ((await tokens.json()) as { access_token: string }).access_token;
    expect(await mcp(access)).toBe(200);
    connectedAccess = access;
  });
  w.assertClean();
});

test('Deny returns access_denied, and a hostile, very long app name stays inside the page', async ({
  page,
}) => {
  const w = await watch(page);
  const name = `<img src=x onerror=alert(1)>${'A'.repeat(70)}`; // under the 100-character cap (P5-03)
  const r = request(await register(name));
  const callback = catchCallback(page, w.problems);
  await page.goto(`${server.base}/auth/login`);
  await page.getByRole('link', { name: 'Continue with Corp SSO' }).click();
  await page.goto(r.url);
  await expect(page.getByRole('heading', { level: 1, name: 'Connect an app' })).toBeVisible();
  // The name is text: no element was made from it.
  await expect(page.locator('main img')).toHaveCount(0);
  await expect(page.locator('.consent-client')).toContainText('<img src=x onerror=alert(1)>');
  await expectNoHorizontalScroll(page);
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Deny' }).click();
  const back = await callback();
  expect(back.searchParams.get('error')).toBe('access_denied');
  expect(back.searchParams.get('state')).toBe(r.state);
  expect(back.searchParams.get('code')).toBeNull();
  w.assertClean();
});

test('My access lists the connected app and Disconnect ends its tokens at once', async ({ page }) => {
  const w = await watch(page);
  await page.goto(`${server.base}/auth/login`);
  await page.getByRole('link', { name: 'Continue with Corp SSO' }).click();
  await visit(page, server, '/admin/me');
  await expect(page.getByRole('heading', { name: 'Connected apps' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Phone app', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'E2E browser', exact: true })).toBeVisible();
  const access = connectedAccess;
  expect(access).not.toBe('');
  expect(await mcp(access)).toBe(200);
  await page.getByRole('button', { name: 'Disconnect Phone app' }).click();
  await expect(page.getByText('Revoked').first()).toBeVisible();
  expect(await mcp(access)).toBe(401);
  await expectNoHorizontalScroll(page);
  w.assertClean();
});

/** The person's browser connects an app: the consent page, Allow, the code exchange. Returns the tokens. */
async function connectInBrowser(page: Page, w: { problems: readonly string[] }, name: string, label: string) {
  const clientId = await register(name);
  const r = request(clientId);
  const callback = catchCallback(page, w.problems);
  await page.goto(r.url);
  await page.getByLabel('Device name (optional)').fill(label);
  await page.getByRole('button', { name: 'Allow' }).click();
  const code = (await callback()).searchParams.get('code') ?? '';
  const tokens = await fetch(`${server.base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: r.verifier,
      resource: `${server.base}/w/${SLUG}/mcp`,
    }),
  });
  expect(tokens.status).toBe(200);
  const json = (await tokens.json()) as { access_token: string; refresh_token: string };
  return { clientId, access: json.access_token, refresh: json.refresh_token };
}

test('P5-08: the owner sees every connected app, disconnects one, and revokes a client, hostile names inert', async ({
  page,
}) => {
  const w = await watch(page);
  const hostile = `<img src=x onerror=alert(1)>${'B'.repeat(70)}`;
  await page.goto(`${server.base}/auth/login`);
  await page.getByRole('link', { name: 'Continue with Corp SSO' }).click();
  const tablet = await connectInBrowser(page, w, 'Tablet app', 'E2E tablet');
  const hostileApp = await connectInBrowser(page, w, hostile, 'E2E hostile');
  expect(await mcp(tablet.access)).toBe(200);
  expect(await mcp(hostileApp.access)).toBe(200);

  await test.step('Connected apps lists them, escaped, and fits the screen', async () => {
    await visit(page, server, '/admin/oauth/devices');
    await expect(page.getByRole('heading', { level: 1, name: 'Connected apps' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Tablet app', exact: true })).toBeVisible();
    await expect(page.locator('main img')).toHaveCount(0);
    await expect(page.locator('main')).toContainText('<img src=x onerror=alert(1)>');
  });

  await test.step('Disconnect ends the app at once; the refresh token is dead too', async () => {
    await page.getByRole('button', { name: /^Disconnect Tablet app of / }).click();
    await expect(page.getByText('Revoked').first()).toBeVisible();
    expect(await mcp(tablet.access)).toBe(401);
    const refused = await fetch(`${server.base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tablet.refresh,
        client_id: tablet.clientId,
      }),
    });
    expect(refused.status).toBe(400);
    expect(await mcp(hostileApp.access)).toBe(200);
    await expectNoHorizontalScroll(page);
  });

  await test.step('OAuth apps lists the clients, with where they send people, and revoking one ends its devices', async () => {
    await visit(page, server, '/admin/oauth/clients');
    await expect(page.getByRole('heading', { level: 1, name: 'OAuth apps' })).toBeVisible();
    await expect(page.locator('main img')).toHaveCount(0);
    await expect(page.getByText('127.0.0.1:53999').first()).toBeVisible();
    await expect(page.getByText('Name (not verified)').first()).toBeVisible();
    // The confirmation sits behind a disclosure; the first activation only opens it.
    const row = page.getByRole('row').filter({ hasText: 'BBBBBBBB' });
    await row.locator('summary').click();
    await row.getByRole('button', { name: 'Revoke this app' }).click();
    await expect(page.getByText('Revoked').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Revoked apps' })).toBeVisible();
    expect(await mcp(hostileApp.access)).toBe(401);
    await expectNoHorizontalScroll(page);
    await expectAccessible(page);
  });
  w.assertClean();
});
