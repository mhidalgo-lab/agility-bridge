// SPDX-License-Identifier: Apache-2.0
// The shortest path through the panel in any browser: the owner setup link, the first sign-in and the overview.
import { expect, test } from '@playwright/test';
import { OWNER, startServer, type TestServer } from './server.ts';
import { watch } from './watch.ts';

let server: TestServer;
test.beforeAll(async () => {
  server = await startServer();
});
test.afterAll(async () => {
  await server?.stop();
});

test('the setup link makes the first sign-in the owner', async ({ page }) => {
  const w = await watch(page);
  await page.goto(await server.setupLink());
  await page.getByRole('button', { name: 'Continue with Corp SSO' }).click();
  await expect(page).toHaveURL(`${server.base}/admin`);
  await expect(page.getByText(OWNER.email).first()).toBeVisible();
  w.assertClean();
});
