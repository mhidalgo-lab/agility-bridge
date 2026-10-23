// SPDX-License-Identifier: Apache-2.0
// P4-08: what unit tests cannot see about the panel's security headers and sign-in, in a real Chromium: the Content
// Security Policy and Trusted Types as the browser enforces them, `form-action` and framing, forged requests from another
// origin on the same site and from another site, cookies, logout, re-authentication and the pages of a signed-out
// visitor. Desktop only: nothing here depends on the viewport.
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { signIn, visit } from './helpers.ts';
import {
  type Evil,
  fakeAgilityToken,
  MEMBER,
  OWNER,
  startEvil,
  startServer,
  type TestServer,
} from './server.ts';
import { watch } from './watch.ts';

test.describe.configure({ mode: 'serial' });

/** The policy of every panel page, written out (a literal, so a change to the source cannot change both sides). */
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'";

let server: TestServer;
let evil: Evil;
let seeded: Awaited<ReturnType<TestServer['seed']>>;

test.beforeAll(async () => {
  server = await startServer();
  evil = await startEvil();
  // The first owner through the setup link, in a throw-away browser context; the rest signs in again.
});
test.afterAll(async () => {
  await evil?.close();
  await server?.stop();
});

const rel = (path: string) => `${server.base}${path}`;

async function owner(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  server.idp.user = { ...OWNER };
  await signIn(page, server);
  return { ctx, page };
}

test('bootstrap: the owner and the data the checks need', async ({ page }) => {
  await page.goto(await server.setupLink());
  await page.getByRole('button', { name: 'Continue with Corp SSO' }).click();
  await expect(page).toHaveURL(rel('/admin'));
  seeded = await server.seed();
  const users = await server.api('GET', '/users');
  expect(JSON.stringify(users.json)).toContain(OWNER.email);
  await server.api('POST', '/users', { email: MEMBER.email, role: 'member', displayName: MEMBER.name });
});

test('every page carries the panel policy, the browser enforces it, and nothing is reported', async ({
  browser,
}) => {
  const { ctx, page } = await owner(browser);
  const w = await watch(page);
  const paths = [
    '/admin',
    '/admin/me',
    '/admin/instances',
    '/admin/instances/new',
    '/admin/credentials',
    '/admin/credentials/new',
    '/admin/workspaces',
    '/admin/workspaces/new',
    '/admin/grants',
    '/admin/grants/new',
    '/admin/users',
    '/admin/users/new',
    '/admin/audit',
    '/admin/usage',
    '/admin/account',
    '/admin/this-page-does-not-exist',
  ];
  for (const path of paths) {
    const res = await page.goto(rel(path));
    const h = res?.headers() ?? {};
    expect(h['content-security-policy'], path).toBe(CSP);
    expect(h['referrer-policy'], path).toBe('same-origin');
    expect(h['cache-control'], path).toBe('no-store');
    expect(h['x-frame-options'], path).toBe('DENY');
    expect(h['x-content-type-options'], path).toBe('nosniff');
    expect(h['cross-origin-opener-policy'], path).toBe('same-origin');
    expect(h['cross-origin-resource-policy'], path).toBe('same-origin');
    expect(h['permissions-policy'], path).toContain('camera=()');
    if (path.endsWith('does-not-exist')) w.expectStatus(404);
  }
  w.assertClean();

  // The browser really enforces it: each attempt below is refused and reported, none runs.
  await visit(page, server, '/admin/users/new');
  const outcome = await page.evaluate(async () => {
    const seen: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) => seen.push(e.violatedDirective));
    const attempt = (what: string, f: () => unknown) => {
      try {
        f();
        return `${what}: allowed`;
      } catch (error) {
        return `${what}: ${(error as Error).name}`;
      }
    };
    const results = [
      // Trusted Types: strings cannot reach HTML sinks.
      attempt('innerHTML', () => {
        document.body.innerHTML = '<b>x</b>';
      }),
      attempt('document.write', () => document.write('<b>x</b>')),
      attempt('script.text', () => {
        const s = document.createElement('script');
        s.text = 'window.__pwned = 1';
        document.head.append(s);
      }),
    ];
    // Subresources the policy does not allow. (`eval` is not tried: Playwright's own evaluate is exempt from the
    // policy's `unsafe-eval` rule, so the panel's lack of it rests on the header assertions above.)
    results.push(
      attempt('script.src', () => {
        const external = document.createElement('script');
        external.src = 'data:text/javascript,window.__pwned=5';
        document.head.append(external);
      }),
    );
    const img = new Image();
    img.src = 'http://127.0.0.1:9/pixel.png';
    document.body.append(img);
    const css = document.createElement('style');
    css.textContent = 'body{background:red}';
    document.head.append(css);
    await new Promise((r) => setTimeout(r, 500));
    return { results, seen, pwned: (window as unknown as { __pwned?: number }).__pwned ?? null };
  });
  expect(outcome.pwned).toBeNull();
  expect(outcome.results.join('\n')).not.toContain('allowed');
  expect(outcome.seen).toEqual(
    expect.arrayContaining(['require-trusted-types-for', 'img-src', 'style-src-elem']),
  );
  await ctx.close();
});

test('a form cannot be sent to another origin, and a framed panel stays empty', async ({ browser }) => {
  const { ctx, page } = await owner(browser);
  await visit(page, server, '/admin/users/new');
  evil.hits.length = 0;
  const violation = await page.evaluate(async (target) => {
    const seen: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) => seen.push(e.violatedDirective));
    const form = document.querySelector('form[action="/admin/users"]') as HTMLFormElement;
    form.setAttribute('action', target);
    (form.querySelector('input[name=email]') as HTMLInputElement).value = 'x@example.com';
    form.requestSubmit();
    await new Promise((r) => setTimeout(r, 800));
    return seen;
  }, `${evil.crossSite}/steal`);
  expect(violation).toContain('form-action');
  expect(evil.hits.filter((h) => h.includes('steal'))).toEqual([]);

  // The panel inside a frame of another site: the browser refuses to render it.
  const evilPage = await ctx.newPage();
  evil.html = `<!doctype html><iframe id=f src="${server.base}/admin"></iframe>`;
  await evilPage.goto(evil.crossSite);
  await evilPage.waitForTimeout(1500);
  const frame = evilPage.frames().find((f) => f !== evilPage.mainFrame());
  expect(frame?.url() ?? 'none').toMatch(/^chrome-error:|^about:blank$|none/);
  expect(await evilPage.content()).not.toContain('Overview');
  await ctx.close();
});

test('forged requests from another origin on the same site and from another site change nothing', async ({
  browser,
}) => {
  const { ctx, page } = await owner(browser);
  const before = JSON.stringify((await server.api('GET', '/users')).json);
  const answers: { url: string; status: number }[] = [];
  ctx.on('response', (r) => {
    if (r.url().startsWith(server.base)) answers.push({ url: r.url(), status: r.status() });
  });
  const form = (action: string) => `<!doctype html><body>
    <form id=f method=post action="${action}">
      <input name=email value="forged@example.com"><input name=role value=owner><input name=_csrf value=x>
    </form><script>f.submit()</script></body>`;

  for (const [name, origin] of [
    ['same-site', evil.sameSite],
    ['cross-site', evil.crossSite],
  ] as const) {
    answers.length = 0;
    // 1. A form posted by the other site's page (a top-level navigation carrying the session cookie when same-site).
    evil.html = form(`${server.base}/admin/users`);
    const p = await ctx.newPage();
    // The inline script of the hostile page runs on its own origin: that is the attack being simulated.
    await p.goto(origin, { waitUntil: 'load' }).catch(() => undefined);
    await p.waitForTimeout(1000);
    const post = answers.find((a) => a.url.endsWith('/admin/users'));
    expect(post, `${name} form post`).toBeDefined();
    expect([303, 403], `${name} form post status`).toContain(post?.status);
    // Never a success: not the redirect to the new user, never the creation.
    expect(await p.content(), name).not.toContain('forged@example.com');

    // 2. A script of the other origin posting with the session cookie attached.
    answers.length = 0;
    evil.html = `<!doctype html><script>fetch('${server.base}/admin/users', {method:'POST', mode:'no-cors', credentials:'include',
      headers:{'content-type':'application/x-www-form-urlencoded'}, body:'email=forged@example.com&role=owner&_csrf=x'})</script>`;
    await p.goto(origin);
    await p.waitForTimeout(1000);
    const fetched = answers.find((a) => a.url.endsWith('/admin/users'));
    if (fetched !== undefined) expect([303, 403], `${name} fetch`).toContain(fetched.status);

    // 3. A subresource request (an image) for a panel page is refused by fetch metadata before the session is read.
    answers.length = 0;
    evil.html = `<!doctype html><img src="${server.base}/admin/users">`;
    await p.goto(origin);
    await p.waitForTimeout(1000);
    const img = answers.find((a) => a.url.endsWith('/admin/users'));
    if (img !== undefined) expect([303, 403], `${name} image`).toContain(img.status);
    // (Usually there is no answer to see at all: the page's `Cross-Origin-Resource-Policy: same-origin` makes the browser
    // drop the response of a cross-origin image before the other site can use it.)
    await p.close();
  }
  expect(JSON.stringify((await server.api('GET', '/users')).json)).toBe(before);
  expect(JSON.stringify((await server.api('GET', '/users')).json)).not.toContain('forged@example.com');

  // A plain link from another site is a top-level navigation and lands on the panel (L-192).
  evil.html = `<!doctype html><a id=go href="${server.base}/admin">panel</a>`;
  const link = await ctx.newPage();
  await link.goto(evil.crossSite);
  await link.click('#go');
  await expect(link).toHaveURL(rel('/admin'));
  await expect(link.getByText(OWNER.email).first()).toBeVisible();
  await ctx.close();
  void page;
});

test('cookies over http: a session cookie the page cannot read, and logout clears it', async ({
  browser,
}) => {
  const { ctx, page } = await owner(browser);
  const w = await watch(page);
  const cookies = await ctx.cookies();
  const session = cookies.find((c) => c.name === 'ab_session');
  expect(session, JSON.stringify(cookies.map((c) => c.name))).toBeDefined();
  expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
  expect(await page.evaluate(() => document.cookie)).not.toContain('ab_session');

  await visit(page, server, '/admin');
  const logout = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/logout'));
  await page.getByRole('button', { name: 'Sign out', exact: true }).first().click();
  const res = await logout;
  expect((await res.allHeaders())['clear-site-data']).toBe('"cookies"');
  expect((await ctx.cookies()).filter((c) => c.name === 'ab_session')).toEqual([]);

  // The panel is closed again; the back button shows nothing from the session.
  await page.goto(rel('/admin'));
  await expect(page).toHaveURL(/\/auth\/login\?next=%2Fadmin$/);
  w.assertClean();
  // Back to the logout answer: a `no-store` page is not replayed from the cache (the browser reports a cache miss).
  await page.goBack().catch(() => undefined);
  expect(await page.content()).not.toContain(OWNER.email);
  w.problems.length = 0;

  // The same session cookie, copied before the logout, is dead on the server.
  const stale = await browser.newContext();
  await stale.addCookies([
    { name: 'ab_session', value: (session as NonNullable<typeof session>).value, url: server.base },
  ]);
  const sp = await stale.newPage();
  await sp.goto(rel('/admin'));
  await expect(sp).toHaveURL(/\/auth\/login/);
  await stale.close();
  await ctx.close();
});

test('sign out everywhere ends the other browsers too', async ({ browser }) => {
  const a = await owner(browser);
  const b = await owner(browser);
  await visit(a.page, server, '/admin');
  await a.page
    .getByRole('button', { name: /Sign out everywhere/ })
    .first()
    .click();
  await b.page.goto(rel('/admin'));
  await expect(b.page).toHaveURL(/\/auth\/login/);
  await a.ctx.close();
  await b.ctx.close();
});

test('signed-out visitors: every panel address leads to the sign-in page and shows nothing', async ({
  page,
}) => {
  for (const path of [
    '/admin',
    '/admin/instances',
    '/admin/credentials/new',
    '/admin/audit',
    '/admin/me',
    '/admin/usage',
  ]) {
    await page.goto(rel(path));
    await expect(page, path).toHaveURL(
      new RegExp(`/auth/login\\?next=${encodeURIComponent(path).replace(/\//g, '%2F')}`),
    );
    await expect(page.getByRole('link', { name: 'Continue with Corp SSO' })).toBeVisible();
  }
  // A forged next address is never followed off site.
  await page.goto(rel(`/auth/login?next=${encodeURIComponent('https://evil.example/x')}`));
  await page.getByRole('link', { name: 'Continue with Corp SSO' }).click();
  await expect(page).toHaveURL(rel('/admin'));
});

test('the identity provider refuses, or the person is not known: no session, a fixed message', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const w = await watch(page);
  server.idp.deny = true;
  await page.goto(rel('/auth/login'));
  await page.getByRole('link', { name: 'Continue with Corp SSO' }).click();
  await expect(page).not.toHaveURL(rel('/admin'));
  server.idp.deny = false;
  expect((await ctx.cookies()).filter((c) => c.name.includes('session'))).toEqual([]);

  // Verified at the provider, but nobody invited this person (automatic provisioning is off).
  server.idp.user = { sub: 'stranger-sub', email: 'stranger@example.com' };
  await page.goto(rel('/auth/login'));
  await page.getByRole('link', { name: 'Continue with Corp SSO' }).click();
  await expect(page).not.toHaveURL(rel('/admin'));
  expect((await ctx.cookies()).filter((c) => c.name.includes('session'))).toEqual([]);
  expect(await page.content()).not.toContain('stranger@example.com');
  server.idp.user = { ...OWNER };
  w.problems.length = 0;
  await ctx.close();
});

test('a change that needs a recent sign-in asks again, changes nothing, and the same person continues', async ({
  browser,
}) => {
  const { ctx, page } = await owner(browser);
  const w = await watch(page);
  const newToken = fakeAgilityToken('replaced');
  const credential = `/admin/credentials/${seeded.credentialId}`;
  const submitReplacement = async () => {
    await visit(page, server, credential);
    await page
      .getByRole('link', { name: /Replace the token/ })
      .first()
      .click();
    await page.getByLabel('New Agility access token', { exact: true }).fill(newToken);
    await page.getByRole('button', { name: 'Replace the token', exact: true }).click();
  };
  const stored = async () =>
    JSON.stringify((await server.api('GET', `/credentials/${seeded.credentialId}`)).json);

  // The sign-in is 11 minutes old: the window for sensitive changes is 10.
  server.ageSessions(11);
  const before = await stored();
  await submitReplacement();
  await expect(page.getByRole('heading', { name: 'Sign in again to continue' })).toBeVisible();
  await expect(page.getByText('Nothing was changed')).toBeVisible();
  expect(await page.content()).not.toContain(newToken);
  w.expectStatus(403);
  expect(await stored()).toBe(before);

  // Another person at the provider cannot confirm the owner's sign-in: refused with a fixed sentence.
  server.idp.user = { ...MEMBER };
  await page.getByRole('link', { name: 'Sign in again' }).click();
  await expect(page.getByRole('heading', { name: 'Sign-in failed' })).toBeVisible();
  await expect(page.getByText('Sign-in was refused.')).toBeVisible();
  expect(await page.content()).not.toContain(MEMBER.email);
  server.idp.user = { ...OWNER };
  expect(await stored()).toBe(before);

  // The owner asks again: the identity provider is told to authenticate afresh (`prompt=login`, `max_age=0`), the page
  // returns to where the change was, and the same change then goes through.
  await submitReplacement();
  await page.getByRole('link', { name: 'Sign in again' }).click();
  await expect(page).toHaveURL(rel(`${credential}/token`));
  const asked = server.idp.authorizations.at(-1);
  expect(asked?.get('prompt')).toBe('login');
  expect(asked?.get('max_age')).toBe('0');
  // Nothing was kept for the person: the form is empty again, and the same change is made from it.
  await expect(page.getByLabel('New Agility access token', { exact: true })).toHaveValue('');
  await page.getByLabel('New Agility access token', { exact: true }).fill(newToken);
  await page.getByRole('button', { name: 'Replace the token', exact: true }).click();
  await expect(page.getByText(`…${newToken.slice(-4)}`).first()).toBeVisible();
  expect(await page.content()).not.toContain(newToken);
  expect(await stored()).not.toBe(before);
  w.expectStatus(403); // the two deliberate re-authentication pages
  w.assertClean();
  await ctx.close();
});
