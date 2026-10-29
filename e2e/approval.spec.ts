// SPDX-License-Identifier: Apache-2.0
// P7-13: the out-of-band approval page (`/admin/approve/<id>`, P7-02) in a real Chromium, at 1280 px and at 320 px,
// against the built `agility-bridge serve` with writes switched on, a fake identity provider and the synthetic Agility.
// The client is a bare HTTP request that cannot elicit: it asks for a status change and is answered "pending" with the
// link; the person is the browser. The synthetic Agility serves no write endpoint, so each test ends at the recorded
// approval or decline (the repeat that applies the change is covered by the unit tests and by P7-07). Every page load is
// watched for CSP violations, console errors and uncaught errors.
import { expect, test } from '@playwright/test';
import { expectAccessible, expectNoHorizontalScroll, signIn } from './helpers.ts';
import { MEMBER, OWNER, startServer, type TestServer } from './server.ts';
import { watch } from './watch.ts';
import { requestApproval, setupWrites, WRITES_ENV, type WritesSetup } from './writes.ts';

test.describe.configure({ mode: 'serial' });

let server: TestServer;
let writes: WritesSetup;

test.beforeAll(async ({ browser }) => {
  server = await startServer({ env: WRITES_ENV });
  // The first sign-in through the setup link makes the owner; then the owner's writable workspace and grant exist.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(await server.setupLink());
  await page.getByRole('button', { name: 'Continue with Corp SSO' }).click();
  await expect(page).toHaveURL(`${server.base}/admin`);
  const session = (await context.cookies()).find((c) => /ab_session$/.test(c.name));
  if (session === undefined) throw new Error('the owner has no session cookie');
  writes = await setupWrites(server, `${session.name}=${session.value}`);
  await context.close();
  await server.api('POST', '/users', { email: MEMBER.email, role: 'member' });
});
test.afterAll(async () => {
  await server?.stop();
});

const rel = (path: string) => `${server.base}${path}`;
const link = () => requestApproval(server, writes.deviceToken);

test('the change is shown whole, with its target, every field old and new, and a change id', async ({
  page,
}) => {
  const w = await watch(page);
  await signIn(page, server);
  const path = await link();
  await page.goto(rel(path));
  await expectNoHorizontalScroll(page);
  await expectAccessible(page);
  await expect(page.getByRole('heading', { name: 'An app asks to change Agility' })).toBeVisible();
  const main = page.locator('main');
  await expect(main).toContainText('update_status');
  await expect(main).toContainText('Writes workspace');
  await expect(main).toContainText('Story B-01001 (Story:1001)');
  await expect(main).toContainText('Synthetic sign-in page');
  const row = page.getByRole('row', { name: /Status/ });
  await expect(row).toContainText('In Progress [StoryStatus:1]');
  await expect(row).toContainText('Done [StoryStatus:2]');
  await expect(main).toContainText(/Change id\s*[0-9a-f]{12}/);
  await expect(page.getByRole('button', { name: 'Approve this change' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Decline' })).toBeVisible();
  w.assertClean();
});

test('decline answers and a second answer finds nothing', async ({ page }) => {
  const w = await watch(page);
  await signIn(page, server);
  const path = await link();
  await page.goto(rel(path));
  await page.getByRole('button', { name: 'Decline' }).click();
  await expect(page.getByRole('heading', { name: 'Declined' })).toBeVisible();
  await expect(page.getByText('Nothing was changed in Agility.')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectAccessible(page);
  // The record was taken: the same link is gone (one answer for used, expired and unknown).
  const again = await page.goto(rel(path));
  expect(again?.status()).toBe(404);
  w.expectStatus(404);
  w.assertClean();
});

test('another person, an unknown id and a malformed id all get the same 404', async ({
  page,
  browser,
}, info) => {
  const w = await watch(page);
  await signIn(page, server);
  const path = await link();
  const mobile = info.project.name.startsWith('mobile');
  const ctx = await browser.newContext({
    viewport: page.viewportSize(),
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  const other = await ctx.newPage();
  const ow = await watch(other);
  server.idp.user = { ...MEMBER };
  try {
    await other.goto(rel('/auth/login'));
    await other.getByRole('link', { name: 'Continue with Corp SSO' }).click();
    await expect(other).toHaveURL(rel('/admin'));
    const bodies: string[] = [];
    for (const p of [path, '/admin/approve/20260101000000-AAAAAAAAAAAAAAAAAAAAAA', '/admin/approve/nope']) {
      const res = await other.goto(rel(p));
      expect(res?.status(), p).toBe(404);
      // The request id differs on every answer; the rest must not.
      bodies.push(
        (await other.locator('main').innerText()).replace(/Request id:\s*\S+/, '').replace(/\s+/g, ' '),
      );
      ow.expectStatus(404);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toContain('update_status');
    ow.assertClean();
  } finally {
    server.idp.user = { ...OWNER };
    await ctx.close();
  }
  // The owner's own link still works after the other person's attempts.
  await page.goto(rel(path));
  await expect(page.getByRole('button', { name: 'Approve this change' })).toBeVisible();
  w.assertClean();
});

test('a page that shows another change than the stored one approves nothing', async ({ page }) => {
  const w = await watch(page);
  await signIn(page, server);
  const path = await link();
  await page.goto(rel(path));
  await page.locator('input[name="hash"]').evaluate((e) => {
    (e as HTMLInputElement).value = '0'.repeat(64);
  });
  await page.getByRole('button', { name: 'Approve this change' }).click();
  await expect(page.getByRole('heading', { name: 'This page is out of date' })).toBeVisible();
  w.expectStatus(409);
  w.assertClean();
});

test('a stale sign-in is sent to sign in again and returns to the page, then approve works once', async ({
  page,
}) => {
  const w = await watch(page);
  await signIn(page, server);
  const path = await link();
  server.ageSessions(11);
  await page.goto(rel(path));
  await expect(page.getByText('Approving a change needs a recent sign-in')).toBeVisible();
  // Nothing to approve with: the approve button is not offered, decline still is.
  await expect(page.getByRole('button', { name: 'Approve this change' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Decline' })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('link', { name: 'Sign in again' }).click();
  await expect(page).toHaveURL(rel(path));
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'Approve this change' }).click();
  await expect(page.getByRole('heading', { name: 'Approved' })).toBeVisible();
  await expect(page.getByText('approved once')).toBeVisible();
  await expectAccessible(page);
  // Used: a second visit finds nothing.
  const again = await page.goto(rel(path));
  expect(again?.status()).toBe(404);
  w.expectStatus(404);
  w.assertClean();
});
