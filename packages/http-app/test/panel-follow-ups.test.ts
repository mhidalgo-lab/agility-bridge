// SPDX-License-Identifier: Apache-2.0
// Panel follow-ups (P4-15, THREAT_MODEL T8, T13, T14, A5): enabling a disabled user, the panel-wide device token list and
// editing an instance's number prefixes, through real sessions, the admin API and the screens, against memory storage (the
// same storage contract as SQLite and D1). Every refusal changes nothing and returns nothing; every panel control is offered
// exactly when the API allows the call; hostile strings stay inert.
import { describe, expect, it } from 'vitest';
import { MIN, setup } from './helpers/panel.ts';

const OWNER = 'owner@example.test';
const ADMIN = 'admin@example.test';
const ALICE = 'alice@example.test';
const EVIL = '<img src=x onerror=alert(1)>"\'</title><script>alert(2)</script>';

type S = Awaited<ReturnType<typeof setup>>;
type Session = { cookie: string; csrf: string };

const enc = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();
const page = (s: S, path: string, who: Session | undefined) =>
  s.send('GET', path, { ...(who === undefined ? {} : { cookie: who.cookie }), site: 'none' });
const submit = (s: S, path: string, who: Session, fields: Record<string, string> = {}) =>
  s.send('POST', path, { cookie: who.cookie, form: enc({ _csrf: who.csrf, ...fields }) });
const flashOf = (res: Response): string | undefined =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith('ab_flash='))
    ?.split(';')[0]
    ?.slice('ab_flash='.length);
/** The page's markup with attribute values blanked: an escaped value may hold the text of a handler, a tag cannot. */
const tagsOnly = (html: string): string => html.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");

async function env() {
  const s = await setup();
  const owner = await s.session(OWNER);
  const admin = await s.session(ADMIN);
  const alice = await s.session(ALICE);
  return { s, owner, admin, alice, ids: s.w.ids };
}
type E = Awaited<ReturnType<typeof env>>;

let counter = 0;
/** A user of `role`, disabled when asked, with a unique email. */
async function person(e: E, role: 'owner' | 'admin' | 'member', disabled: boolean) {
  const n = ++counter;
  const u = await e.s.w.storage.users.create({
    id: `usr_fu${n}`,
    email: `fu${n}@example.test`,
    role,
    displayName: `Person ${n}`,
  });
  if (disabled) await e.s.w.storage.users.update(u.id, { disabledAt: e.s.w.now.t });
  return u.id;
}
const actions = async (s: S) => (await s.rows()).map((r) => `${r.action}:${r.status}`);

// ---------------------------------------------------------------------------------------------------------------
// POST /users/{id}/enable
// ---------------------------------------------------------------------------------------------------------------

describe('POST /users/{id}/enable', () => {
  it('lets a disabled person sign in again, audits it, and creates no session by itself', async () => {
    const e = await env();
    const { s, owner } = e;
    // Alice is disabled: her session ends and she cannot sign in.
    expect((await s.api('POST', `/users/${e.ids.alice}/disable`, owner)).status).toBe(200);
    expect((await s.signIn(ALICE)).status).not.toBe(303);
    const sessions = (await s.w.storage.kv.list('sess:')).length;
    const res = await s.api('POST', `/users/${e.ids.alice}/enable`, owner);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: e.ids.alice, disabledAt: null, role: 'member' });
    // Nothing was created: she signs in herself.
    expect((await s.w.storage.kv.list('sess:')).length).toBe(sessions);
    expect((await s.signIn(ALICE)).status).toBe(303);
    const row = (await s.rows()).find((r) => r.action === 'user.enable');
    expect(row).toMatchObject({
      status: 'ok',
      userId: e.ids.owner,
      targetType: 'user',
      targetId: e.ids.alice,
    });
  });

  it('follows the rules of disabling: an owner for owners and admins (recently signed in), an admin for members', async () => {
    const e = await env();
    const { s } = e;
    const viewers = [
      ['owner', e.owner],
      ['admin', e.admin],
      ['member', e.alice],
    ] as const;
    // A second owner keeps the "last owner" rule out of the way.
    await person(e, 'owner', false);
    for (const [viewerRole, who] of viewers) {
      for (const role of ['owner', 'admin', 'member'] as const) {
        const id = await person(e, role, true);
        const res = await s.api('POST', `/users/${id}/enable`, who);
        const allowed = viewerRole === 'owner' || (viewerRole === 'admin' && role === 'member');
        expect(res.status, `${viewerRole} enables ${role}`).toBe(allowed ? 200 : 403);
        expect((await s.w.storage.users.get(id))?.disabledAt === null, `${viewerRole} enables ${role}`).toBe(
          allowed,
        );
      }
    }
  });

  it('needs a recent sign-in for owners and admins, not for members, and a refusal writes nothing', async () => {
    const e = await env();
    const { s, owner } = e;
    const admin = await person(e, 'admin', true);
    const owner2 = await person(e, 'owner', true);
    const member = await person(e, 'member', true);
    s.w.now.t += 11 * MIN;
    for (const id of [admin, owner2]) {
      const res = await s.api('POST', `/users/${id}/enable`, owner);
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('reauth_required');
      expect((await s.w.storage.users.get(id))?.disabledAt).not.toBeNull();
    }
    expect((await s.api('POST', `/users/${member}/enable`, owner)).status).toBe(200);
    expect(await actions(s)).not.toContain('user.enable:ok:' + admin);
    expect((await s.rows()).filter((r) => r.action === 'user.enable' && r.status === 'ok')).toHaveLength(1);
  });

  it('answers 409 for a user who is not disabled, 404 for a missing one, 401 without a session, and writes nothing', async () => {
    const e = await env();
    const { s, owner } = e;
    const before = JSON.stringify(await s.w.storage.users.list());
    const active = await s.api('POST', `/users/${e.ids.alice}/enable`, owner);
    expect(active.status).toBe(409);
    expect((await s.api('POST', '/users/usr_missing/enable', owner)).status).toBe(404);
    const anon = await s.send('POST', `/api/admin/v1/users/${e.ids.alice}/enable`, { body: {} });
    expect(anon.status).toBe(401);
    expect(JSON.stringify(await s.w.storage.users.list())).toBe(before);
    expect((await s.rows()).filter((r) => r.action === 'user.enable' && r.status === 'ok')).toHaveLength(0);
  });

  it('does not tell a refused caller whether the user is disabled', async () => {
    const e = await env();
    const disabled = await person(e, 'member', true);
    const active = await person(e, 'member', false);
    const a = await e.s.api('POST', `/users/${disabled}/enable`, e.alice);
    const b = await e.s.api('POST', `/users/${active}/enable`, e.alice);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    expect(await a.json()).toEqual(await b.json());
  });

  it('the panel offers Enable exactly where the API allows it, for every role and target', async () => {
    const e = await env();
    const { s } = e;
    await person(e, 'owner', false);
    for (const [viewerRole, who] of [
      ['owner', e.owner],
      ['admin', e.admin],
    ] as const) {
      for (const role of ['owner', 'admin', 'member'] as const) {
        for (const disabled of [true, false]) {
          const id = await person(e, role, disabled);
          const doc = await (await page(s, `/admin/users/${id}`, who)).text();
          const offered = doc.includes('Enable…');
          const api = await s.api('POST', `/users/${id}/enable`, who);
          expect(offered, `${viewerRole} enables ${disabled ? 'disabled' : 'active'} ${role}`).toBe(
            api.status === 200,
          );
          // Disable is offered the other way round, for the same people.
          expect(
            doc.includes('Disable…'),
            `${viewerRole} disables ${disabled ? 'disabled' : 'active'} ${role}`,
          ).toBe(!disabled && (viewerRole === 'owner' || role === 'member'));
        }
      }
    }
  });

  it('enables through the panel only after a confirmation, and says what comes back', async () => {
    const e = await env();
    const { s, admin } = e;
    const id = await person(e, 'member', true);
    const ask = await submit(s, `/admin/users/${id}/enable`, admin);
    expect(ask.status).toBe(200);
    const doc = await ask.text();
    expect(doc).toContain('device token');
    expect((await s.w.storage.users.get(id))?.disabledAt).not.toBeNull();
    const done = await submit(s, `/admin/users/${id}/enable`, admin, { confirm: 'yes' });
    expect(done.status).toBe(303);
    expect(flashOf(done)).toBe('enabled');
    expect((await s.w.storage.users.get(id))?.disabledAt).toBeNull();
    expect((await s.rows()).filter((r) => r.action === 'user.enable' && r.status === 'ok')).toHaveLength(1);
    // The disable page no longer says it cannot be undone.
    const again = await (await submit(s, `/admin/users/${e.ids.alice}/disable`, admin)).text();
    expect(again).not.toContain('no way to enable');
  });

  it('refuses forged panel requests and changes nothing: members, admins on owners, an active person, missing CSRF', async () => {
    const e = await env();
    const { s, admin, alice } = e;
    await person(e, 'owner', false);
    const owner2 = await person(e, 'owner', true);
    const member = await person(e, 'member', true);
    const active = await person(e, 'member', false);
    const snapshot = async () =>
      JSON.stringify({ users: await s.w.storage.users.list(), sessions: await s.w.storage.kv.list('sess:') });
    const before = await snapshot();
    // A member (the screen is for admins), an admin on an owner (the API refuses), an active person (409).
    const memberTry = await submit(s, `/admin/users/${member}/enable`, alice, { confirm: 'yes' });
    expect([303, 403]).toContain(memberTry.status);
    if (memberTry.status === 303) expect(flashOf(memberTry)).not.toBe('enabled');
    const ownerTry = await submit(s, `/admin/users/${owner2}/enable`, admin, { confirm: 'yes' });
    expect(flashOf(ownerTry)).toBe('not_allowed');
    const activeTry = await submit(s, `/admin/users/${active}/enable`, admin, { confirm: 'yes' });
    expect(flashOf(activeTry)).toBe('conflict');
    // No CSRF token: refused before anything runs.
    const noCsrf = await s.send('POST', `/admin/users/${member}/enable`, {
      cookie: admin.cookie,
      form: enc({ confirm: 'yes' }),
    });
    expect([400, 403]).toContain(noCsrf.status);
    expect(await snapshot()).toBe(before);
    expect((await s.rows()).filter((r) => r.action === 'user.enable' && r.status === 'ok')).toHaveLength(0);
  });

  it('shows hostile names inertly on the confirmation page', async () => {
    const e = await env();
    const id = await person(e, 'member', true);
    await e.s.w.storage.users.update(id, { displayName: EVIL });
    const html = await (await submit(e.s, `/admin/users/${id}/enable`, e.admin)).text();
    expect(html).not.toContain(EVIL);
    expect(tagsOnly(html)).not.toMatch(/<img|<script[^>]*>[^<]/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// GET /tokens
// ---------------------------------------------------------------------------------------------------------------

/** A valid, unique token hash (64 lower-case hex digits). */
const hashOf = (n: number): string => n.toString(16).padStart(64, '0');

/** Tokens straight into storage, so their order and times are exact. Returns the ids, oldest first. */
async function seedTokens(e: E, grantId: string, labels: string[], step = 1_000): Promise<string[]> {
  const out: string[] = [];
  for (const label of labels) {
    e.s.w.now.t += step;
    const id = `tok_seed${++counter}`;
    await e.s.w.storage.accessTokens.create({
      id,
      grantId,
      prefix: `ab_live_${String(counter).padStart(4, '0')}`,
      tokenHash: hashOf(counter),
      label,
    });
    out.push(id);
  }
  return out;
}
type Listed = { data: Array<{ id: string } & Record<string, unknown>>; next: string | null };
const listTokens = async (e: E, who: Session, query = ''): Promise<{ status: number; body: Listed }> => {
  const res = await e.s.api('GET', `/tokens${query}`, who);
  return { status: res.status, body: (await res.json()) as Listed };
};

async function tokenEnv() {
  const e = await env();
  const { s } = e;
  // A service grant (shared credential) and Alice's own grant, each with tokens.
  const shared = await s.w.storage.credentials.list({ instanceId: e.ids.instance });
  const sharedId = shared.find((c) => c.ownerUserId === null)?.id;
  let serviceGrant: string;
  if (sharedId === undefined) {
    const made = await s.api('POST', '/credentials', e.owner, {
      instanceId: e.ids.instance,
      ownerUserId: null,
      label: 'Team token',
      token: `1.${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const cred = (await made.json()).id as string;
    await s.w.storage.credentials.update(cred, { validationStatus: 'valid' });
    const g = await s.api('POST', '/grants', e.owner, {
      workspaceId: e.ids.workspaceA,
      userId: null,
      label: 'ci',
      credentialId: cred,
    });
    serviceGrant = (await g.json()).record.id as string;
  } else {
    const g = await s.api('POST', '/grants', e.owner, {
      workspaceId: e.ids.workspaceA,
      userId: null,
      label: 'ci',
      credentialId: sharedId,
    });
    serviceGrant = (await g.json()).record.id as string;
  }
  return { ...e, serviceGrant };
}

describe('GET /tokens', () => {
  it('lists every token for owners and admins, newest first, with the grant, and never a hash or a token', async () => {
    const e = await tokenEnv();
    const svc = await seedTokens(e, e.serviceGrant, ['ci-a', 'ci-b']);
    const mine = await seedTokens(e, e.ids.aliceGrant, ['alice-laptop']);
    for (const who of [e.owner, e.admin]) {
      const { status, body } = await listTokens(e, who);
      expect(status).toBe(200);
      expect(body.next).toBeNull();
      const ids = body.data.map((t) => t.id);
      // Newest first, and the seeded tokens, the world's own token included.
      expect(ids.slice(0, 3)).toEqual([mine[0], svc[1], svc[0]]);
      expect(ids).toContain(e.ids.aliceToken);
      const first = body.data[0] as Record<string, unknown>;
      expect(first).toMatchObject({
        grantId: e.ids.aliceGrant,
        userId: e.ids.alice,
        workspaceId: e.ids.workspaceA,
      });
      expect(body.data[1]).toMatchObject({ grantId: e.serviceGrant, userId: null, grantLabel: 'ci' });
      expect(Object.keys(first).sort()).toEqual(
        [
          'createdAt',
          'expiresAt',
          'grantId',
          'grantLabel',
          'id',
          'label',
          'lastUsedAt',
          'prefix',
          'revokedAt',
          'userId',
          'workspaceId',
        ].sort(),
      );
      const dump = JSON.stringify(body);
      expect(dump).not.toContain('tokenHash');
      expect(dump).not.toMatch(/\b[0-9a-f]{64}\b/);
      for (const secret of Object.values(e.s.w.tokens)) expect(dump).not.toContain(secret);
    }
  });

  it('shows a member only the tokens of their own grants, and nobody else anything', async () => {
    const e = await tokenEnv();
    await seedTokens(e, e.serviceGrant, ['ci-a']);
    await seedTokens(e, e.ids.aliceGrant, ['alice-laptop']);
    const mine = await listTokens(e, e.alice);
    expect(mine.status).toBe(200);
    expect(mine.body.data.length).toBeGreaterThan(0);
    for (const t of mine.body.data) expect(t['userId']).toBe(e.ids.alice);
    // Someone else's grant is "not found"; someone else's user id matches nothing; a service grant is not hers.
    const foreign = await e.s.api('GET', `/tokens?grantId=${e.serviceGrant}`, e.alice);
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(await foreign.json())).not.toContain('ci-a');
    const other = await listTokens(e, e.alice, `?userId=${e.ids.owner}`);
    expect(other.status).toBe(200);
    expect(other.body.data).toEqual([]);
    const self = await listTokens(e, e.alice, `?userId=${e.ids.alice}`);
    expect(self.body.data.map((t) => t.id)).toEqual(mine.body.data.map((t) => t.id));
  });

  it('answers 401 without a session and returns nothing', async () => {
    const e = await tokenEnv();
    const res = await e.s.send('GET', '/api/admin/v1/tokens');
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain('"data"');
  });

  it('filters by grant and by person', async () => {
    const e = await tokenEnv();
    const svc = await seedTokens(e, e.serviceGrant, ['ci-a', 'ci-b']);
    const byGrant = await listTokens(e, e.owner, `?grantId=${e.serviceGrant}`);
    expect(byGrant.body.data.map((t) => t.id)).toEqual([svc[1], svc[0]]);
    const byUser = await listTokens(e, e.admin, `?userId=${e.ids.alice}`);
    expect(byUser.body.data.length).toBeGreaterThan(0);
    for (const t of byUser.body.data) expect(t['userId']).toBe(e.ids.alice);
    const both = await listTokens(e, e.owner, `?grantId=${e.serviceGrant}&userId=${e.ids.alice}`);
    expect(both.body.data).toEqual([]);
    expect((await e.s.api('GET', '/tokens?grantId=grt_missing', e.owner)).status).toBe(404);
    const none = await listTokens(e, e.owner, '?userId=usr_nobody');
    expect(none.body).toEqual({ data: [], next: null });
  });

  it('rejects a malformed cursor, limit and filters, and lists nothing', async () => {
    const e = await tokenEnv();
    await seedTokens(e, e.serviceGrant, ['ci-a']);
    for (const q of [
      '?after=garbage',
      '?after=1:',
      '?after=12:a b',
      `?after=${encodeURIComponent(EVIL)}`,
      `?after=${'9'.repeat(40)}:x`,
      '?limit=0',
      '?limit=201',
      '?limit=abc',
      `?grantId=${'x'.repeat(200)}`,
    ]) {
      const res = await e.s.api('GET', `/tokens${q}`, e.owner);
      expect(res.status, q).toBe(422);
      expect(JSON.stringify(await res.json()), q).not.toContain('"data"');
    }
  });

  it('pages by keyset: no repeat and no gap while tokens are added, revoked and share a timestamp', async () => {
    const e = await tokenEnv();
    // Seven tokens, three of them created in the same millisecond (ties are broken by id).
    const early = await seedTokens(e, e.serviceGrant, ['a', 'b', 'c', 'd']);
    const tie = [];
    e.s.w.now.t += 1_000;
    for (const label of ['t1', 't2', 't3']) {
      const id = `tok_tie${++counter}`;
      await e.s.w.storage.accessTokens.create({
        id,
        grantId: e.serviceGrant,
        prefix: 'ab_live_ti00',
        tokenHash: hashOf(counter),
        label,
      });
      tie.push(id);
    }
    const everything = (await listTokens(e, e.owner, `?grantId=${e.serviceGrant}`)).body.data.map(
      (t) => t.id,
    );
    expect(everything).toHaveLength(7);
    const seen: unknown[] = [];
    let after = '';
    for (let n = 0; n < 10; n++) {
      const { status, body } = await listTokens(e, e.owner, `?grantId=${e.serviceGrant}&limit=3${after}`);
      expect(status).toBe(200);
      seen.push(...body.data.map((t) => t.id));
      if (n === 0) {
        // Between two pages: a newer token appears and an older one is revoked.
        await seedTokens(e, e.serviceGrant, ['newer']);
        expect((await e.s.api('POST', `/tokens/${early[0]}/revoke`, e.owner)).status).toBe(200);
      }
      if (body.next === null) break;
      after = `&after=${encodeURIComponent(body.next)}`;
    }
    // Every token that existed throughout is seen exactly once, in the order of the unpaged list; the newer one is not.
    expect(seen).toEqual(everything);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('keeps hostile labels inert in the list', async () => {
    const e = await tokenEnv();
    const [id] = await seedTokens(e, e.serviceGrant, [EVIL]);
    await e.s.w.storage.grants.update(e.serviceGrant, { label: EVIL });
    const { body } = await listTokens(e, e.owner, `?grantId=${e.serviceGrant}`);
    expect(body.data[0]).toMatchObject({ id, label: EVIL, grantLabel: EVIL });
    const html = await (await page(e.s, '/admin/tokens', e.owner)).text();
    expect(html).not.toContain(EVIL);
    expect(tagsOnly(html)).not.toMatch(/<img|<script[^>]*>[^<]/i);
  });
});

describe('/admin/tokens', () => {
  it('is for owners and admins: the menu entry and the page, never for members or visitors', async () => {
    const e = await tokenEnv();
    for (const who of [e.owner, e.admin]) {
      const res = await page(e.s, '/admin/tokens', who);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('href="/admin/tokens"');
    }
    const member = await page(e.s, '/admin/tokens', e.alice);
    expect(member.status).toBe(403);
    expect(await member.text()).not.toContain('Device tokens</caption>');
    expect((await (await page(e.s, '/admin', e.alice)).text()).includes('href="/admin/tokens"')).toBe(false);
    const anon = await page(e.s, '/admin/tokens', undefined);
    expect([302, 303, 401]).toContain(anon.status);
  });

  it('lists tokens with their grant, a revoke button only for live ones, and the same button works', async () => {
    const e = await tokenEnv();
    const [live, dead] = await seedTokens(e, e.serviceGrant, ['phone', 'old-laptop']);
    await e.s.w.storage.accessTokens.update(dead as string, { revokedAt: e.s.w.now.t });
    for (const who of [e.owner, e.admin]) {
      const html = await (await page(e.s, '/admin/tokens', who)).text();
      expect(html).toContain('phone');
      expect(html).toContain('service: ci');
      expect(html).toContain(`/admin/grants/${e.serviceGrant}/tokens/${live}/revoke`);
      expect(html).not.toContain(`/admin/grants/${e.serviceGrant}/tokens/${dead}/revoke`);
      expect(html).not.toMatch(/\b[0-9a-f]{64}\b/);
    }
    // Controls match the API: the revoke the panel offers is one the API accepts, and not before the confirmation.
    const ask = await submit(e.s, `/admin/grants/${e.serviceGrant}/tokens/${live}/revoke`, e.admin);
    expect(ask.status).toBe(200);
    expect((await e.s.w.storage.accessTokens.get(live as string))?.revokedAt).toBeNull();
    const done = await submit(e.s, `/admin/grants/${e.serviceGrant}/tokens/${live}/revoke`, e.admin, {
      confirm: 'yes',
    });
    expect(flashOf(done)).toBe('revoked');
    expect((await e.s.w.storage.accessTokens.get(live as string))?.revokedAt).not.toBeNull();
  });

  it('filters, pages with the API cursor, and ignores a forged cursor, grant or person', async () => {
    const e = await tokenEnv();
    // 55 tokens, so the first page (the API default is 50) has a next page.
    await seedTokens(
      e,
      e.serviceGrant,
      Array.from({ length: 55 }, (_, i) => `dev-${i}`),
      10,
    );
    const first = await (await page(e.s, '/admin/tokens', e.owner)).text();
    const next = /href="(\/admin\/tokens\?after=[^"]+)"/.exec(first.replaceAll('&amp;', '&'))?.[1];
    expect(next).toBeDefined();
    const second = await (await page(e.s, next as string, e.owner)).text();
    expect(second).toContain('Newest entries');
    expect(second).not.toContain('Next page');
    // A cursor, grant or person the API would refuse is dropped, not forwarded: the page is the unfiltered first page.
    for (const q of [`?after=${encodeURIComponent(EVIL)}`, '?grant=a%20b', '?user=../x', '?after=1:']) {
      const res = await page(e.s, `/admin/tokens${q}`, e.owner);
      expect(res.status, q).toBe(200);
      expect(await res.text(), q).toContain('dev-54');
    }
    const filtered = await (await page(e.s, `/admin/tokens?user=${e.ids.alice}`, e.owner)).text();
    expect(filtered).not.toContain('dev-54');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Number prefixes
// ---------------------------------------------------------------------------------------------------------------

describe('number prefixes', () => {
  const patch = (e: E, who: Session, numberPrefixes: unknown, id = e.ids.instance) =>
    e.s.api('PATCH', `/instances/${id}`, who, { numberPrefixes });

  it('stores valid prefixes on every path, replaces them as a whole, and clears them with null', async () => {
    const e = await env();
    for (const who of [e.owner, e.admin]) {
      const res = await patch(e, who, { Story: 'S', Defect: 'B', Test: 'AT' });
      expect(res.status).toBe(200);
      expect((await res.json()).numberPrefixes).toEqual({ Story: 'S', Defect: 'B', Test: 'AT' });
    }
    expect((await patch(e, e.owner, { Story: 'S' })).status).toBe(200);
    expect((await e.s.w.storage.instances.get(e.ids.instance))?.numberPrefixes).toEqual({ Story: 'S' });
    expect((await patch(e, e.owner, null)).status).toBe(200);
    expect((await e.s.w.storage.instances.get(e.ids.instance))?.numberPrefixes).toBeNull();
    const created = await e.s.api('POST', '/instances', e.owner, {
      label: 'Other',
      baseUrl: 'https://other.example.test/Agility',
      numberPrefixes: { Epic: 'E' },
    });
    expect([200, 201]).toContain(created.status);
    expect((await created.json()).numberPrefixes).toEqual({ Epic: 'E' });
  });

  it('refuses hostile type names and prefixes on update and create, and changes nothing', async () => {
    const e = await env();
    await patch(e, e.owner, { Story: 'S' });
    const before = JSON.stringify(await e.s.w.storage.instances.list());
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`Type${i}`, 'A']));
    const bad: unknown[] = [
      { Story: 's' },
      { Story: 'STORY' },
      { Story: '' },
      { Story: 'S1' },
      { Story: 'S-' },
      { Story: 'É' },
      { Story: 5 },
      { Story: null },
      { Story: ['S'] },
      { Story: { a: 'S' } },
      { 'Story Type': 'S' },
      { 'Story"] or 1=1 --': 'S' },
      { '../Story': 'S' },
      { '1Story': 'S' },
      { '': 'S' },
      { [EVIL]: 'S' },
      { Story: EVIL },
      { Story: 'S\n' },
      ['Story'],
      'Story=S',
      42,
      many,
    ];
    for (const value of bad) {
      const res = await patch(e, e.owner, value);
      expect(res.status, JSON.stringify(value).slice(0, 60)).toBe(422);
      const create = await e.s.api('POST', '/instances', e.owner, {
        label: 'X',
        baseUrl: 'https://x.example.test/A',
        numberPrefixes: value,
      });
      expect(create.status, JSON.stringify(value).slice(0, 60)).toBe(422);
    }
    expect(JSON.stringify(await e.s.w.storage.instances.list())).toBe(before);
    expect(
      (await e.s.rows()).filter((r) => r.action === 'instance.update' && r.status === 'ok'),
    ).toHaveLength(1);
  });

  it('refuses members and visitors, and a refusal writes nothing', async () => {
    const e = await env();
    const before = JSON.stringify(await e.s.w.storage.instances.list());
    expect((await patch(e, e.alice, { Story: 'S' })).status).toBe(403);
    const anon = await e.s.send('PATCH', `/api/admin/v1/instances/${e.ids.instance}`, {
      body: { numberPrefixes: { Story: 'S' } },
    });
    expect(anon.status).toBe(401);
    expect(JSON.stringify(await e.s.w.storage.instances.list())).toBe(before);
  });

  it('the panel form shows the stored prefixes, saves them through the API, and sends only a change', async () => {
    const e = await env();
    const path = `/admin/instances/${e.ids.instance}/prefixes`;
    for (const who of [e.owner, e.admin]) {
      const res = await page(e.s, path, who);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Type=PREFIX');
    }
    const saved = await submit(e.s, path, e.admin, { prefixes: ' Story = S \r\n\r\nDefect=B\n' });
    expect(flashOf(saved)).toBe('saved');
    expect((await e.s.w.storage.instances.get(e.ids.instance))?.numberPrefixes).toEqual({
      Story: 'S',
      Defect: 'B',
    });
    const shown = await (await page(e.s, path, e.owner)).text();
    expect(shown).toContain('Defect=B\nStory=S');
    // The detail page lists them.
    expect(await (await page(e.s, `/admin/instances/${e.ids.instance}`, e.owner)).text()).toContain(
      'Story: S',
    );
    // The same values again, in another order: no API call, no audit row.
    const writes = () => e.s.rows().then((r) => r.filter((x) => x.action === 'instance.update').length);
    const count = await writes();
    expect(flashOf(await submit(e.s, path, e.owner, { prefixes: 'Story=S\nDefect=B' }))).toBe('saved');
    expect(await writes()).toBe(count);
    // Empty clears.
    expect(flashOf(await submit(e.s, path, e.owner, { prefixes: '  \n' }))).toBe('saved');
    expect((await e.s.w.storage.instances.get(e.ids.instance))?.numberPrefixes).toBeNull();
  });

  it('shows invalid input as an error on the form, escaped, and stores nothing', async () => {
    const e = await env();
    await patch(e, e.owner, { Story: 'S' });
    const path = `/admin/instances/${e.ids.instance}/prefixes`;
    const before = JSON.stringify(await e.s.w.storage.instances.list());
    for (const text of [
      'Story',
      '=S',
      'Story=',
      'Story=S=T',
      'Story=S\nStory=B',
      'Story=s',
      'Story=TOOLONG',
      `${EVIL}=S`,
      `Story=${EVIL}`,
      'x'.repeat(5_000),
      Array.from({ length: 70 }, (_, i) => `T${i}=A`).join('\n'),
      '__proto__=S',
    ]) {
      const res = await submit(e.s, path, e.admin, { prefixes: text });
      expect(res.status, text.slice(0, 40)).toBe(422);
      const html = await res.text();
      expect(html).not.toContain(EVIL);
      expect(tagsOnly(html)).not.toMatch(/<img|<script[^>]*>[^<]/i);
    }
    expect(JSON.stringify(await e.s.w.storage.instances.list())).toBe(before);
  });

  it('is closed to members and to a missing CSRF token, with no side effect', async () => {
    const e = await env();
    const path = `/admin/instances/${e.ids.instance}/prefixes`;
    const before = JSON.stringify(await e.s.w.storage.instances.list());
    expect((await page(e.s, path, e.alice)).status).toBe(403);
    const memberPost = await submit(e.s, path, e.alice, { prefixes: 'Story=S' });
    expect([303, 403]).toContain(memberPost.status);
    const noCsrf = await e.s.send('POST', path, {
      cookie: e.admin.cookie,
      form: enc({ prefixes: 'Story=S' }),
    });
    expect([400, 403]).toContain(noCsrf.status);
    expect((await page(e.s, '/admin/instances/ins_missing/prefixes', e.owner)).status).toBe(404);
    expect(JSON.stringify(await e.s.w.storage.instances.list())).toBe(before);
  });
});
