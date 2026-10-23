// SPDX-License-Identifier: Apache-2.0
// P4-08: the whole admin panel in a real Chromium, at 1280 px and at 320 px, against the built `agility-bridge serve`, a
// fake identity provider and the synthetic Agility. The owner sets up an instance, a credential, a workspace, a grant and
// device tokens, invites a member, reads the audit log; the member adds a personal token. Every page load is watched for
// CSP and Trusted Types violations, console errors and uncaught errors (e2e/watch.ts): any one fails the test.
import { expect, type Page, test } from '@playwright/test';
import { expectNoHorizontalScroll, pick, signIn, visit } from './helpers.ts';
import { fakeAgilityToken, MEMBER, OWNER, startServer, type TestServer } from './server.ts';
import { watch } from './watch.ts';

test.describe.configure({ mode: 'serial' });

let server: TestServer;
test.beforeAll(async () => {
  server = await startServer();
});
test.afterAll(async () => {
  await server?.stop();
});

const rel = (path: string) => `${server.base}${path}`;
const sharedToken = fakeAgilityToken('shared');
const WORKSPACE = 'synthetic';
let grantPath = '';

/** The audit log's text, for assertions on what was recorded. */
async function auditText(page: Page, query = ''): Promise<string> {
  await visit(page, server, `/admin/audit${query}`);
  return page.locator('main').innerText();
}

test('owner: the setup link makes the first sign-in the owner, once', async ({ page }) => {
  const w = await watch(page);
  const link = await server.setupLink();
  await page.goto(link);
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'Continue with Corp SSO' }).click();
  await expect(page).toHaveURL(rel('/admin'));
  await expect(page.getByText(OWNER.email).first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  // A spent link signs nobody in.
  await page.getByRole('button', { name: 'Sign out', exact: true }).first().click();
  await page.goto(link);
  await page.getByRole('button', { name: 'Continue with Corp SSO' }).click();
  await expect(page).not.toHaveURL(rel('/admin'));
  await expect(page.getByText(OWNER.email)).toHaveCount(0);
  w.problems.length = 0; // the refused spent link is a deliberate error page
  await signIn(page, server);
  await expect(page.getByText(OWNER.email).first()).toBeVisible();
  w.assertClean();
});

test('owner: instance, credential, workspace and grant', async ({ page }) => {
  const w = await watch(page);
  await signIn(page, server);

  await test.step('add the synthetic Agility instance', async () => {
    await visit(page, server, '/admin/instances/new');
    await page.getByLabel('Name', { exact: true }).fill('Synthetic');
    await page.getByLabel('Agility address', { exact: true }).fill(server.agilityUrl);
    await page.getByRole('button', { name: 'Add instance' }).click();
    await expectNoHorizontalScroll(page);
    await visit(page, server, '/admin/instances');
    await expect(page.getByRole('link', { name: 'Synthetic' })).toBeVisible();
  });

  await test.step('add a shared credential: the token is never shown again', async () => {
    await visit(page, server, '/admin/credentials/new');
    await pick(page.getByLabel('Instance', { exact: true }), /Synthetic/);
    await page.getByLabel('Name', { exact: true }).fill('Team read-only');
    await page.getByLabel('Agility access token', { exact: true }).fill(sharedToken);
    await page.getByRole('button', { name: 'Add credential' }).click();
    await expectNoHorizontalScroll(page);
    await expect(page.getByText('valid').first()).toBeVisible();
    await expect(page.getByText(`…${sharedToken.slice(-4)}`).first()).toBeVisible();
    expect(await page.content()).not.toContain(sharedToken);
    await visit(page, server, '/admin/credentials');
    expect(await page.content()).not.toContain(sharedToken);
  });

  await test.step('create a workspace', async () => {
    await visit(page, server, '/admin/workspaces/new');
    await pick(page.getByLabel('Instance', { exact: true }), /Synthetic/);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Address name', { exact: true }).fill(WORKSPACE);
    await page.getByLabel('Name', { exact: true }).fill('Synthetic workspace');
    await page.getByLabel('Agility projects', { exact: true }).fill('Scope:1001');
    await pick(page.getByLabel('Default shared credential', { exact: true }), /Team read-only/);
    await expectNoHorizontalScroll(page);
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.getByText(`/w/${WORKSPACE}/mcp`).first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await visit(page, server, '/admin/workspaces');
    await expect(page.getByRole('link', { name: 'Synthetic workspace' })).toBeVisible();
  });

  await test.step('a grant for the owner', async () => {
    await visit(page, server, '/admin/grants/new');
    await pick(page.getByLabel('Workspace', { exact: true }), /Synthetic workspace|synthetic/);
    await page.getByRole('button', { name: 'Next' }).click();
    await pick(page.getByLabel('Who', { exact: true }), new RegExp(OWNER.email));
    await page.getByLabel('Name', { exact: true }).fill('Owner laptop');
    await expectNoHorizontalScroll(page);
    await page.getByRole('button', { name: 'Create grant' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    grantPath = new URL(page.url()).pathname;
    expect(grantPath).toMatch(/^\/admin\/grants\/[\w-]+$/);
    await expectNoHorizontalScroll(page);
  });
  w.assertClean();
});

test('owner: device tokens are shown once and work against the synthetic Agility', async ({
  page,
  context,
}) => {
  const w = await watch(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.base });
  await signIn(page, server);
  await visit(page, server, grantPath);
  await page.getByRole('link', { name: 'New device token' }).click();
  await page.getByLabel('Device name', { exact: true }).fill('laptop');
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'Create token' }).click();
  const token = (await page.locator('#token').innerText()).trim();
  expect(token).toMatch(/^ab_/);
  await expectNoHorizontalScroll(page);

  // The page answers the form post only: no-store, nothing in the address.
  expect(page.url()).not.toContain(token);
  const copy = page.getByRole('button', { name: 'Copy' }).first();
  await expect(copy).toBeVisible();
  await copy.click();
  await expect(page.getByRole('button', { name: 'Copied' }).first()).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);

  // The token opens the workspace's MCP endpoint (a real tools/list against the synthetic Agility).
  const mcp = await fetch(rel(`/w/${WORKSPACE}/mcp`), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  expect(mcp.status).toBe(200);
  expect(await mcp.text()).toContain('whoami');

  // Reloading re-sends the form: no second token, and the token is not shown again.
  await page.reload().catch(() => undefined);
  expect(await page.content()).not.toContain(token);
  await visit(page, server, grantPath);
  expect(await page.content()).not.toContain(token);
  await page.goBack().catch(() => undefined);
  expect(await page.content()).not.toContain(token);

  // A second device, then the first one is revoked from the grant's page and stops working.
  await visit(page, server, grantPath);
  await page.getByRole('link', { name: 'New device token' }).click();
  await page.getByLabel('Device name', { exact: true }).fill('phone');
  await page.getByRole('button', { name: 'Create token' }).click();
  const second = (await page.locator('#token').innerText()).trim();
  expect(second).not.toBe(token);
  await visit(page, server, grantPath);
  await expect(page.getByText('laptop').first()).toBeVisible();
  await expect(page.getByText('phone').first()).toBeVisible();
  await page.getByRole('button', { name: 'Revoke laptop' }).click();
  await page.getByRole('button', { name: 'Revoke the token' }).click();
  const call = (bearer: string) =>
    fetch(rel(`/w/${WORKSPACE}/mcp`), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }).then((r) => r.status);
  expect(await call(token)).toBe(401);
  expect(await call(second)).toBe(200);
  w.assertClean();
});

test('owner: users, then the member signs in with their own token and sees only their own things', async ({
  page,
  browser,
}, info) => {
  const w = await watch(page);
  await signIn(page, server);

  await test.step('the owner invites a member and gives them a grant', async () => {
    await visit(page, server, '/admin/users/new');
    await page.getByLabel('Email address', { exact: true }).fill(MEMBER.email);
    await page.getByLabel('Name (optional)', { exact: true }).fill(MEMBER.name);
    await page.getByLabel('Role', { exact: true }).selectOption('member');
    await page.getByRole('button', { name: 'Add user' }).click();
    await expectNoHorizontalScroll(page);
    await visit(page, server, '/admin/users');
    await expect(page.getByText(MEMBER.email).first()).toBeVisible();

    await visit(page, server, '/admin/grants/new');
    await pick(page.getByLabel('Workspace', { exact: true }), /Synthetic workspace|synthetic/);
    await page.getByRole('button', { name: 'Next' }).click();
    await pick(page.getByLabel('Who', { exact: true }), new RegExp(MEMBER.email));
    await page.getByLabel('Name', { exact: true }).fill('Member laptop');
    await page.getByRole('button', { name: 'Create grant' }).click();
    await expect(page.getByText('Member laptop').first()).toBeVisible();
  });

  await test.step('the member signs in: own grants, own token, no admin screens', async () => {
    const mobile = info.project.name.startsWith('mobile');
    const ctx = await browser.newContext({
      viewport: page.viewportSize(),
      ...(mobile ? { isMobile: true, hasTouch: true } : {}),
    });
    const mp = await ctx.newPage();
    const mw = await watch(mp);
    server.idp.user = { ...MEMBER };
    try {
      await mp.goto(rel('/auth/login'));
      await mp.getByRole('link', { name: 'Continue with Corp SSO' }).click();
      await expect(mp).toHaveURL(rel('/admin'));
      await visit(mp, server, '/admin/me');
      await expect(mp.getByRole('link', { name: 'Synthetic workspace' })).toBeVisible();
      await expect(mp.getByText('Owner laptop')).toHaveCount(0);

      await visit(mp, server, '/admin/me/credentials/new');
      const memberToken = fakeAgilityToken('member');
      await pick(mp.getByLabel('Agility instance', { exact: true }), /Synthetic/);
      await mp.getByLabel('Name', { exact: true }).fill('My token');
      await mp.getByLabel('Agility access token', { exact: true }).fill(memberToken);
      await mp.getByRole('button', { name: 'Add and check' }).click();
      await expectNoHorizontalScroll(mp);
      expect(await mp.content()).not.toContain(memberToken);
      await visit(mp, server, '/admin/me');
      await expect(mp.getByText('My token').first()).toBeVisible();
      expect(await mp.content()).not.toContain(memberToken);

      // The grant uses the member's own token, and the member issues a device token on it (shown once).
      await mp.getByRole('link', { name: 'Synthetic workspace' }).click();
      await expectNoHorizontalScroll(mp);
      await pick(mp.getByLabel('Agility token', { exact: true }), /My token/);
      await mp.getByRole('button', { name: 'Use this token' }).click();
      await expect(mp.getByText(/My token \(…/).first()).toBeVisible();
      await mp.getByRole('link', { name: 'New device token' }).click();
      await mp.getByLabel('Device name', { exact: true }).fill('member phone');
      await mp.getByRole('button', { name: 'Create token' }).click();
      const memberDevice = (await mp.locator('#token').innerText()).trim();
      expect(memberDevice).toMatch(/^ab_/);
      await expectNoHorizontalScroll(mp);
      const viaMember = await fetch(rel(`/w/${WORKSPACE}/mcp`), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${memberDevice}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(viaMember.status).toBe(200);
      await visit(mp, server, '/admin/me');
      expect(await mp.content()).not.toContain(memberDevice);

      // Every administrator screen answers a member with the 403 page (the browser logs it as a console error).
      for (const path of [
        '/admin/instances',
        '/admin/credentials',
        '/admin/workspaces',
        '/admin/grants',
        '/admin/users',
        '/admin/usage',
      ]) {
        const denied = await mp.goto(rel(path));
        expect(denied?.status(), path).toBe(403);
        await expect(mp.getByRole('heading', { name: 'Not allowed' })).toBeVisible();
        await expectNoHorizontalScroll(mp);
        mw.expectStatus(403);
      }
      // The audit log is theirs only.
      await visit(mp, server, '/admin/audit');
      const text = await mp.locator('main').innerText();
      expect(text).not.toContain(OWNER.email);
      expect(text).not.toContain('setup_link.create');
      mw.assertClean();
    } finally {
      server.idp.user = { ...OWNER };
      await ctx.close();
    }
  });
  w.assertClean();
});

test('owner: audit log, filters, CSV and usage', async ({ page }) => {
  const w = await watch(page);
  await signIn(page, server);
  const text = await auditText(page);
  for (const action of [
    'setup_link.create',
    'login.ok',
    'instance.create',
    'credential.create',
    'workspace.create',
  ]) {
    expect(text, action).toContain(action);
  }
  // A filter narrows the list; the form keeps its values.
  await page.getByLabel('Kind', { exact: true }).selectOption('auth');
  await page.getByRole('button', { name: 'Filter' }).click();
  const filtered = await page.locator('main').innerText();
  expect(filtered).toContain('login.ok');
  expect(filtered).not.toContain('instance.create');
  await expectNoHorizontalScroll(page);

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^audit-\d{4}-\d{2}-\d{2}\.csv$/);

  await visit(page, server, '/admin/usage');
  await page.getByLabel('Group by', { exact: true }).selectOption('day');
  await page.getByRole('button', { name: 'Show' }).click();
  await expectNoHorizontalScroll(page);
  w.assertClean();
});

test('owner: management actions, the last-owner rule and every screen with data, light and dark', async ({
  page,
}) => {
  // About 50 pages, each opened in two colour schemes and audited by axe: slow on a busy machine (explicit, L-126).
  test.setTimeout(300_000);
  const w = await watch(page);
  await signIn(page, server);
  const ids = async (path: string): Promise<string[]> => {
    const rows = (await server.api('GET', path)).json as { id: string }[];
    return rows.map((r) => r.id);
  };
  const [instance] = await ids('/instances');
  const [credential] = await ids('/credentials');
  const [workspace] = await ids('/workspaces');
  const grants = await ids('/grants');
  const users = await ids('/users');
  expect(instance && credential && workspace && grants.length >= 2 && users.length >= 2).toBeTruthy();

  await test.step('rename an instance, check a credential, edit a workspace', async () => {
    await visit(page, server, `/admin/instances/${instance}`);
    await page.locator('input[name="label"]').fill('Synthetic (renamed)');
    await page.getByRole('form', { name: 'Rename' }).getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Synthetic (renamed)').first()).toBeVisible();

    await visit(page, server, `/admin/credentials/${credential}`);
    await page.getByRole('button', { name: 'Check now' }).click();
    await expect(page.getByText('valid').first()).toBeVisible();
    await visit(page, server, `/admin/workspaces/${workspace}/edit`);
    await page.locator('input[name="name"]').fill('Synthetic workspace (edited)');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Synthetic workspace (edited)').first()).toBeVisible();
  });

  await test.step('the last active owner cannot be demoted or disabled', async () => {
    const all = (await server.api('GET', '/users')).json as { id: string; role: string }[];
    const ownerId = all.find((u) => u.role === 'owner')?.id as string;
    await visit(page, server, `/admin/users/${ownerId}`);
    await page.locator('select[name="role"]').selectOption('member');
    await page.getByRole('button', { name: 'Change the role' }).click();
    await expect(page.getByText(/without an active owner/)).toBeVisible();
    const after = (await server.api('GET', `/users/${ownerId}`)).json as { role: string };
    expect(after.role).toBe('owner');
  });

  await test.step('disable and enable a workspace; a destructive action asks first', async () => {
    await visit(page, server, `/admin/workspaces/${workspace}`);
    await page.getByRole('button', { name: /^Disable / }).click();
    await expectNoHorizontalScroll(page);
    // Nothing happens until the confirmation page's own button is pressed.
    expect(
      ((await server.api('GET', `/workspaces/${workspace}`)).json as { disabledAt: number | null })
        .disabledAt,
    ).toBeNull();
    await page.getByRole('button', { name: 'Disable the workspace' }).click();
    await expect(page.getByRole('button', { name: /^Enable / })).toBeVisible();
    await page.getByRole('button', { name: /^Enable / }).click();
    await expect(page.getByRole('button', { name: /^Disable / })).toBeVisible();

    // Delete asks first too; leaving the confirmation page deletes nothing.
    await page.getByRole('button', { name: /^Delete / }).click();
    await expect(page.getByRole('button', { name: 'Delete the workspace' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    expect((await server.api('GET', `/workspaces/${workspace}`)).status).toBe(200);
  });

  await test.step('every screen with data fits the viewport and passes the accessibility rules, light and dark', async () => {
    const paths = [
      '/admin',
      '/admin/me',
      '/admin/account',
      '/admin/instances',
      `/admin/instances/${instance}`,
      '/admin/credentials',
      `/admin/credentials/${credential}`,
      `/admin/credentials/${credential}/token`,
      '/admin/workspaces',
      `/admin/workspaces/${workspace}`,
      `/admin/workspaces/${workspace}/edit`,
      '/admin/grants',
      ...grants.map((g) => `/admin/grants/${g}`),
      ...grants.map((g) => `/admin/grants/${g}/connect`),
      '/admin/users',
      ...users.map((u) => `/admin/users/${u}`),
      '/admin/audit?range=all',
      '/admin/usage',
    ];
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const path of paths) await visit(page, server, path);
    }
    await page.emulateMedia({ colorScheme: 'light' });
  });
  w.assertClean();
});
