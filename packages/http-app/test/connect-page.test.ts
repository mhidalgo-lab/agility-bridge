// SPDX-License-Identifier: Apache-2.0
// The Connect page (P4-06, THREAT_MODEL T8, T13, A5): endpoint and client snippets for a grant, against real sessions and
// memory storage. Negative authorization first (L-121): someone else's grant is the 404 page for every role in the member
// area, the admin area refuses members, a signed-out visitor goes to sign-in; the Connect page never holds a token, the
// one-time page holds it exactly where a client has no other way, and nothing else (redirect, flash, log, audit) ever does.
import { describe, expect, it } from 'vitest';
import { setup } from './helpers/panel.ts';

const OWNER = 'owner@example.test';
const ADMIN = 'admin@example.test';
const ALICE = 'alice@example.test';

type S = Awaited<ReturnType<typeof setup>>;
type Session = { cookie: string; csrf: string };

const page = (s: S, path: string, who: Session | undefined, headers: Record<string, string> = {}) =>
  s.send('GET', path, { ...(who === undefined ? {} : { cookie: who.cookie }), site: 'none', headers });
const enc = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();
const submit = (s: S, path: string, who: Session, fields: Record<string, string> = {}) =>
  s.send('POST', path, { cookie: who.cookie, form: enc({ _csrf: who.csrf, ...fields }) });
const handleOf = (html: string) => /name="_once" value="([^"]+)"/.exec(html)?.[1] as string;
const CLIENTS = [
  'GitHub Copilot in VS Code',
  'GitHub Copilot in JetBrains IDEs',
  'GitHub Copilot CLI',
  'Claude Code (command)',
  'Claude Code (.mcp.json)',
  'Cursor',
  'Windsurf / Devin Desktop',
  'MCP Inspector',
];

async function env() {
  const s = await setup({ publicUrl: 'http://127.0.0.1:8787' });
  const owner = await s.session(OWNER);
  const admin = await s.session(ADMIN);
  const alice = await s.session(ALICE);
  const bob = await s.session('bob@example.test');
  const users = await s.w.storage.users.list();
  const bobId = users.find((u) => u.email === 'bob@example.test')?.id as string;
  const bobGrant = (await s.w.storage.grants.list({ userId: bobId }))[0]?.id as string;
  const workspaceB = (await s.w.storage.workspaces.list()).find((w) => w.slug === 'team-b')?.id as string;
  const aliceGrantB = (await s.w.storage.grants.list({ userId: s.w.ids.alice })).find(
    (g) => g.workspaceId === workspaceB,
  )?.id as string;
  return { s, owner, admin, alice, bob, ids: { ...s.w.ids, bobGrant, workspaceB, aliceGrantB } };
}

describe('who may open the Connect page', () => {
  it('shows a member the endpoint and every client for their own grant, with placeholders and no token', async () => {
    const e = await env();
    const res = await page(e.s, `/admin/me/grants/${e.ids.aliceGrant}/connect`, e.alice);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const html = await res.text();
    expect(html).toContain('http://127.0.0.1:8787/w/team-a/mcp');
    for (const c of CLIENTS) expect(html, c).toContain(c);
    expect(html).toContain('ab_&lt;your device token&gt;');
    expect(html).toContain(`/admin/me/grants/${e.ids.aliceGrant}/tokens/new`);
    expect(html).not.toMatch(/ab_(live|test)_[A-Za-z0-9_-]{8,}/);
    expect(html).not.toMatch(/<script[^>]*>[^<]/i);
    // Fixtures hold device tokens; none is on the page.
    expect(html).not.toContain('team-b/mcp');
  });

  it("gives someone else's grant the 404 page in the member area, for every role", async () => {
    const e = await env();
    const before = JSON.stringify([
      await e.s.w.storage.grants.list(),
      await e.s.w.storage.accessTokens.list(),
    ]);
    for (const [name, who] of [
      ['member', e.alice],
      ['owner', e.owner],
      ['admin', e.admin],
    ] as const) {
      const res = await page(e.s, `/admin/me/grants/${e.ids.bobGrant}/connect`, who);
      expect(res.status, name).toBe(404);
      const html = await res.text();
      expect(html, name).not.toContain('team-b');
      expect(html, name).not.toContain('127.0.0.1:8787/w/');
    }
    for (const bad of ['nope', 'grt_missing', '..%2f..', `${e.ids.aliceGrant}x`]) {
      const res = await page(e.s, `/admin/me/grants/${bad}/connect`, e.alice);
      expect(res.status, bad).toBe(404);
    }
    expect(JSON.stringify([await e.s.w.storage.grants.list(), await e.s.w.storage.accessTokens.list()])).toBe(
      before,
    );
  });

  it('keeps the admin area for owners and admins, and sends strangers to sign-in', async () => {
    const e = await env();
    const path = `/admin/grants/${e.ids.bobGrant}/connect`;
    for (const [name, who] of [
      ['owner', e.owner],
      ['admin', e.admin],
    ] as const) {
      const res = await page(e.s, path, who);
      expect(res.status, name).toBe(200);
      expect(await res.text(), name).toContain('/w/team-b/mcp');
    }
    const member = await page(e.s, path, e.alice);
    expect(member.status).not.toBe(200);
    expect(await member.text()).not.toContain('/w/team-b/mcp');
    const out = await page(e.s, path, undefined);
    expect(out.status).toBe(303);
    expect(out.headers.get('location')).toContain('/auth/login');
    const out2 = await page(e.s, `/admin/me/grants/${e.ids.aliceGrant}/connect`, undefined);
    expect(out2.status).toBe(303);
  });

  it('offers no token link for a grant that cannot issue one, and says why', async () => {
    const e = await env();
    await e.s.w.storage.grants.update(e.ids.aliceGrant, { revokedAt: e.s.w.now.t });
    const res = await page(e.s, `/admin/me/grants/${e.ids.aliceGrant}/connect`, e.alice);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('revoked or expired');
    expect(html).not.toContain('/tokens/new');
  });

  it('warns when the workspace is disabled', async () => {
    const e = await env();
    await e.s.w.storage.workspaces.update(e.ids.workspaceB, { disabledAt: e.s.w.now.t });
    const html = await (await page(e.s, `/admin/me/grants/${e.ids.aliceGrantB}/connect`, e.alice)).text();
    expect(html).toContain('workspace is disabled');
  });

  it('builds addresses from the configured public origin only', async () => {
    const e = await env();
    const res = await page(e.s, `/admin/me/grants/${e.ids.aliceGrant}/connect`, e.alice, {
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
      forwarded: 'host=evil.example',
    });
    const html = await res.text();
    expect(html).toContain('http://127.0.0.1:8787/w/team-a/mcp');
    expect(html).not.toContain('evil.example');
    const other = await page(e.s, `/admin/me/grants/${e.ids.aliceGrant}/connect`, e.alice, {
      host: 'evil.example',
    });
    expect(await other.text()).not.toContain('evil.example');
  });
});

describe('the token on the one-time page', () => {
  it('appears in the token box and the JetBrains snippet only, never in a redirect, flash, URL, log or audit row', async () => {
    const e = await env();
    const { s, alice } = e;
    const grantPath = `/admin/me/grants/${e.ids.aliceGrant}`;
    const form = await (await page(s, `${grantPath}/tokens/new`, alice)).text();
    const fields = { label: 'work-phone', lifetime: '30', _once: handleOf(form) };
    const issued = await submit(s, `${grantPath}/tokens`, alice, fields);
    expect(issued.status).toBe(200);
    expect(issued.headers.get('cache-control')).toBe('no-store');
    const html = await issued.text();
    const token = /<code id="token">([^<]+)<\/code>/.exec(html)?.[1] as string;
    expect(token).toMatch(/^ab_/);
    expect(html).toContain('http://127.0.0.1:8787/w/team-a/mcp');
    // The token is in the box and in the one snippet that has no other way to take it.
    expect(html.split(token).length - 1).toBe(2);
    const jetbrains = /<code id="snippet-jetbrains">([^<]*)<\/code>/.exec(html)?.[1] ?? '';
    expect(jetbrains).toContain(`Bearer ${token}`);
    for (const id of [
      'vscode',
      'copilot-cli',
      'claude-code',
      'claude-code-json',
      'cursor',
      'windsurf',
      'inspector',
    ]) {
      const body = new RegExp(`<code id="snippet-${id}">([^<]*)</code>`).exec(html)?.[1] ?? '';
      expect(body, id).not.toBe('');
      expect(body, id).not.toContain(token);
    }
    // A re-sent form: nothing issued, no token on the answer, none in the redirect.
    const again = await submit(s, `${grantPath}/tokens`, alice, fields);
    expect(again.status).toBe(303);
    const where = again.headers.get('location') ?? '';
    const everything = [where, ...again.headers.getSetCookie(), await again.text()].join('\n');
    expect(everything).not.toContain(token);
    // The Connect page after issuing, a fresh form and the grant page never show it.
    for (const path of [`${grantPath}/connect`, grantPath, `${grantPath}/tokens/new`, '/admin/me']) {
      const body = await (await page(s, path, alice)).text();
      expect(body, path).not.toContain(token);
    }
    expect(s.w.logs.join('\n')).not.toContain(token);
    expect(JSON.stringify(await s.rows())).not.toContain(token);
    expect(JSON.stringify(await s.w.storage.accessTokens.list())).not.toContain(token);
  });
});
