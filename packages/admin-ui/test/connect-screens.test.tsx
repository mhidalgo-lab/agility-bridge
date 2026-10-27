// SPDX-License-Identifier: Apache-2.0
// The Connect page against a fake admin API (P4-06, THREAT_MODEL T8, T13): hostile workspace names and slugs, the address
// from the configured origin only, nothing written by a GET or a HEAD, and the member area showing only the member's grants.
// The real API, roles and storage are exercised in `packages/http-app/test/connect-page.test.ts`.
import { describe, expect, it } from 'vitest';
import { type Fake, fakeDeps, get } from './helpers/fake-deps.ts';

const asAdmin = { 'x-test-session': 'admin' };
const asMember = { 'x-test-session': 'member' };
const HOSTILE = '<img src=x onerror=alert(1)>"\'';

const grant = (over: Record<string, unknown> = {}) => ({
  id: 'grt_1',
  workspaceId: 'wsp_1',
  userId: 'usr_member',
  label: null,
  credentialId: null,
  limits: {},
  createdAt: 1,
  expiresAt: null,
  revokedAt: null,
  ...over,
});
const workspace = (over: Record<string, unknown> = {}) => ({
  id: 'wsp_1',
  slug: 'team-a',
  name: 'Team A',
  instanceId: 'ins_1',
  disabledAt: null,
  ...over,
});
function api(f: Fake, routes: Record<string, unknown>) {
  f.respond = (call) => {
    const hit = routes[`${call.method} ${call.path}`];
    return hit === undefined
      ? { status: 404, body: { error: { code: 'not_found', message: 'no' } } }
      : { status: 200, body: hit };
  };
}

describe('connect page', () => {
  it('shows the endpoint from the configured origin, whatever Host says, and writes nothing', async () => {
    const f = fakeDeps();
    api(f, { 'GET /grants/grt_1': grant(), 'GET /workspaces/wsp_1': workspace() });
    const res = await get(f, '/admin/grants/grt_1/connect', {
      ...asAdmin,
      host: 'evil.example',
      'x-forwarded-host': 'evil.example',
    });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('https://bridge.example.test/w/team-a/mcp');
    expect(html).not.toContain('evil.example');
    const head = await f.app.request('/admin/grants/grt_1/connect', {
      method: 'HEAD',
      headers: { ...asAdmin, 'sec-fetch-site': 'same-origin' },
    });
    expect(head.status).toBe(200);
    expect(f.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(f.once.size).toBe(0);
  });

  it('does not call OAuth a later release: it is shipped (P5-10)', async () => {
    const f = fakeDeps();
    api(f, { 'GET /grants/grt_1': grant(), 'GET /workspaces/wsp_1': workspace() });
    const html = await (await get(f, '/admin/grants/grt_1/connect', asAdmin)).text();
    expect(html).toContain('Needs OAuth');
    expect(html).not.toContain('later release');
    expect(html).not.toContain('yet.');
  });

  it('escapes a hostile workspace name', async () => {
    const f = fakeDeps();
    api(f, { 'GET /grants/grt_1': grant(), 'GET /workspaces/wsp_1': workspace({ name: HOSTILE }) });
    const html = await (await get(f, '/admin/grants/grt_1/connect', asAdmin)).text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('shows no snippet for a slug the storage would not hold', async () => {
    for (const slug of [HOSTILE, '${input:x}', 'a"b', "a'b", '$(id)']) {
      const f = fakeDeps();
      api(f, { 'GET /grants/grt_1': grant(), 'GET /workspaces/wsp_1': workspace({ slug }) });
      const res = await get(f, '/admin/grants/grt_1/connect', asAdmin);
      const html = await res.text();
      expect(res.status, slug).toBe(502);
      expect(html, slug).not.toContain('<code id="snippet-');
      expect(html, slug).not.toContain(slug);
    }
  });

  it("keeps the member area to the member's own grants", async () => {
    const f = fakeDeps();
    api(f, {
      'GET /grants/grt_1': grant({ userId: 'usr_other' }),
      'GET /workspaces/wsp_1': workspace(),
      'GET /me/grants': [{ grant: grant({ userId: 'usr_other' }), workspace: workspace() }],
    });
    const res = await get(f, '/admin/me/grants/grt_1/connect', asMember);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('team-a');
    // An owner or admin is "someone else" there too.
    expect((await get(f, '/admin/me/grants/grt_1/connect', asAdmin)).status).toBe(404);
    // The admin area refuses a member before any call.
    f.calls.length = 0;
    expect((await get(f, '/admin/grants/grt_1/connect', asMember)).status).toBe(403);
    expect(f.calls).toEqual([]);
  });

  it('shows the member their own grant, with the workspace from their grant list', async () => {
    const f = fakeDeps();
    api(f, {
      'GET /grants/grt_1': grant(),
      'GET /me/grants': [{ grant: grant(), workspace: workspace({ name: HOSTILE }) }],
    });
    const html = await (await get(f, '/admin/me/grants/grt_1/connect', asMember)).text();
    expect(html).toContain('/w/team-a/mcp');
    expect(html).toContain('/admin/me/grants/grt_1/tokens/new');
    expect(html).not.toContain('<img src=x');
  });
});
