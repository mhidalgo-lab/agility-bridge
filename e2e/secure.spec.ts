// SPDX-License-Identifier: Apache-2.0
// P4-08: the panel as a deployment serves it, over https. A TLS proxy with a throw-away self-signed certificate fronts
// the server, whose public address is then `https://localhost:<port>`: the cookies get their `__Host-` names and
// `Secure`, responses carry HSTS, and logout sends `Clear-Site-Data`. Plain http (the other specs) is the loopback mode
// and uses the plain names. Desktop only.
import { type BrowserContext, expect, test } from '@playwright/test';
import { startServer, type TestServer } from './server.ts';
import { watch } from './watch.ts';

let server: TestServer;
test.beforeAll(async () => {
  server = await startServer({ secure: true });
});
test.afterAll(async () => {
  await server?.stop();
});

const names = async (ctx: BrowserContext) => (await ctx.cookies()).map((c) => c.name).sort();

test('https: __Host- cookies, Secure, HSTS and Clear-Site-Data', async ({ browser }) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const w = await watch(page);
  expect(server.base.startsWith('https://')).toBe(true);

  await page.goto(await server.setupLink());
  // The sign-in flow's own cookie (set while the browser goes to the identity provider): host-only, Secure, HttpOnly.
  const start = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/auth/setup'),
  );
  await page.getByRole('button', { name: 'Continue with Corp SSO' }).click();
  const flow = ((await (await start).allHeaders())['set-cookie'] ?? '').toString();
  expect(flow).toMatch(/__Host-ab_login=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax; Secure/);
  expect(flow).not.toMatch(/Domain=/i);
  await expect(page).toHaveURL(`${server.base}/admin`);

  const all = await ctx.cookies();
  const session = all.find((c) => c.name === '__Host-ab_session');
  expect(session, JSON.stringify(await names(ctx))).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
  });
  expect(all.map((c) => c.name)).not.toContain('ab_session');
  expect(await page.evaluate(() => document.cookie)).toBe('');

  // HSTS and the panel's headers over TLS.
  const res = await page.goto(`${server.base}/admin`);
  const h = (await res?.allHeaders()) ?? {};
  expect(h['strict-transport-security']).toMatch(/max-age=\d+/);
  expect(h['content-security-policy']).toContain("require-trusted-types-for 'script'");

  // A flash message travels in a `__Host-` cookie too (fixed code, never text).
  await page.goto(`${server.base}/admin/instances/new`);
  await page.getByLabel('Name', { exact: true }).fill('Synthetic');
  await page.getByLabel('Agility address', { exact: true }).fill(server.agilityUrl);
  const flash = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/admin/instances'),
  );
  await page.getByRole('button', { name: 'Add instance' }).click();
  const setCookie = ((await (await flash).allHeaders())['set-cookie'] ?? '').toString();
  expect(setCookie).toContain('__Host-ab_flash=');
  expect(setCookie).toMatch(/__Host-ab_flash=[^;]*;[^\n]*Secure/);

  // Logout: the cookie is cleared by the server and by `Clear-Site-Data`, which browsers honour over https only.
  await page.goto(`${server.base}/admin`);
  const logout = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/logout'));
  await page.getByRole('button', { name: 'Sign out', exact: true }).first().click();
  const out = await logout;
  expect((await out.allHeaders())['clear-site-data']).toBe('"cookies"');
  expect((await ctx.cookies()).filter((c) => c.name.startsWith('__Host-ab_session'))).toEqual([]);
  await page.goto(`${server.base}/admin`);
  await expect(page).toHaveURL(/\/auth\/login/);
  w.assertClean();
  await ctx.close();
});
