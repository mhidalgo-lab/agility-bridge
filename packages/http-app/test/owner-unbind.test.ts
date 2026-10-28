// SPDX-License-Identifier: Apache-2.0
// Moving a user to another identity on purpose (P4-12, THREAT_MODEL T11, T14, L-092, L-093, L-220): the owner-only,
// re-authenticated, confirmed, audited unbind through real sessions, the admin API and the panel, against memory storage
// (the same storage contract as SQLite and D1). A refusal changes nothing (no unbind, no ended session, no ok row).
import { describe, expect, it } from 'vitest';
import { MIN, setup } from './helpers/panel.ts';

const OWNER = 'owner@example.test';
const ADMIN = 'admin@example.test';
const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';
const OFFER = 'Move to another provider…';

type S = Awaited<ReturnType<typeof setup>>;
type Session = { cookie: string; csrf: string };

const enc = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();
const page = (s: S, path: string, who: Session) => s.send('GET', path, { cookie: who.cookie, site: 'none' });
const submit = (s: S, path: string, who: Session, fields: Record<string, string> = {}) =>
  s.send('POST', path, { cookie: who.cookie, form: enc({ _csrf: who.csrf, ...fields }) });
const flashOf = (res: Response): string | undefined =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith('ab_flash='))
    ?.split(';')[0]
    ?.slice('ab_flash='.length);

async function env() {
  const s = await setup();
  const owner = await s.session(OWNER);
  const admin = await s.session(ADMIN);
  const alice = await s.session(ALICE);
  // A second owner, so "yourself" and "last owner" are told apart from the role rules.
  const second = await s.w.storage.users.create({
    id: 'usr_second_owner',
    email: 'second@example.test',
    role: 'owner',
  });
  return { s, owner, admin, alice, ids: s.w.ids, second };
}

/** Everything a refused unbind must leave alone: users (bindings) and live sessions. */
async function state(s: S): Promise<string> {
  return JSON.stringify({
    users: await s.w.storage.users.list(),
    sessions: (await s.w.storage.kv.list('sess:')).length,
  });
}
const actions = async (s: S) => (await s.rows()).map((r) => `${r.action}:${r.status}`);
const unbindRows = async (s: S) => (await s.rows()).filter((r) => r.action === 'user.unbind');

describe('POST /users/{id}/unbind', () => {
  it('clears the identity as an owner, ends the sessions, and the person binds again at the next verified sign-in', async () => {
    const { s, owner, alice, ids } = await env();
    const before = await s.w.storage.users.get(ids.alice);
    expect(before?.idp).not.toBeNull();
    expect((await s.api('GET', '/users', alice)).status).toBe(200);
    const res = await s.api('POST', `/users/${ids.alice}/unbind`, owner, {
      confirm: '  Alice@Example.Test ',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: ids.alice, idp: null, idpSubject: null, role: 'member' });
    expect(
      await s.w.storage.users.getByIdentity(before?.idp as string, before?.idpSubject as string),
    ).toBeNull();
    // Their browser session ended, and an unrelated one did not.
    expect((await s.api('GET', '/users', alice)).status).toBe(401);
    expect((await s.api('GET', '/users', owner)).status).toBe(200);
    // Another provider account with the same verified email binds now.
    const again = await s.signIn(ALICE, { claims: { sub: 'a-different-subject' } });
    expect(again.status).toBe(303);
    expect(await s.w.storage.users.get(ids.alice)).toMatchObject({ idpSubject: 'a-different-subject' });
    // The audit rows: the previous provider only, never the subject or the typed email.
    const rows = await s.rows();
    const ok = rows.filter((r) => r.action === 'user.unbind');
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({
      status: 'ok',
      userId: ids.owner,
      targetType: 'user',
      targetId: ids.alice,
      details: { previousIdp: before?.idp, actor: 'owner', fields: ['confirm'] },
    });
    const revoked = rows.find((r) => r.action === 'session.revoke_all' && r.targetId === ids.alice);
    expect(revoked?.details).toMatchObject({ reason: 'unbind' });
    const dump = JSON.stringify(
      rows.filter((r) => r.action === 'user.unbind' || r.action === 'session.revoke_all'),
    );
    expect(dump).not.toContain(before?.idpSubject as string);
    expect(dump.toLowerCase()).not.toContain('alice@example.test');
  });

  it('refuses everyone but an owner with a recent sign-in, and a refusal changes nothing', async () => {
    const { s, owner, admin, alice, ids } = await env();
    const target = `/users/${ids.alice}/unbind`;
    const body = { confirm: ALICE };
    const before = await state(s);
    // An admin, a member (also about an owner), a stranger.
    expect((await s.api('POST', target, admin, body)).status).toBe(403);
    expect((await s.api('POST', target, alice, body)).status).toBe(403);
    expect((await s.api('POST', `/users/${ids.owner}/unbind`, alice, { confirm: OWNER })).status).toBe(403);
    expect((await s.send('POST', `/api/admin/v1${target}`, { body })).status).toBe(401);
    expect(await state(s)).toBe(before);
    s.w.now.t += 11 * MIN;
    const stale = await s.api('POST', target, owner, body);
    expect(stale.status).toBe(403);
    expect((await stale.json()).error.code).toBe('reauth_required');
    expect(await state(s)).toBe(before);
    expect(await actions(s)).not.toContain('user.unbind:ok');
    expect(await actions(s)).not.toContain('session.revoke_all:ok');
    expect((await unbindRows(s)).map((r) => r.status)).toEqual(['denied', 'denied', 'denied', 'denied']);
  });

  it('is not available for your own account through a session; another owner can do it', async () => {
    const { s, owner, ids, second } = await env();
    await s.session('second@example.test'); // binds the second owner
    const before = await state(s);
    const self = await s.api('POST', `/users/${ids.owner}/unbind`, owner, { confirm: OWNER });
    expect(self.status).toBe(403);
    expect(JSON.stringify(await self.json())).toContain('your own');
    expect(await state(s)).toBe(before);
    const other = await s.api('POST', `/users/${second.id}/unbind`, owner, {
      confirm: 'second@example.test',
    });
    expect(other.status).toBe(200);
    expect((await s.api('GET', '/users', owner)).status).toBe(200);
  });

  it('needs the typed email, an existing binding and an existing user, and tells them apart', async () => {
    const { s, owner, ids } = await env();
    const before = await state(s);
    const post = (id: string, body: unknown) => s.api('POST', `/users/${id}/unbind`, owner, body);
    const wrong = await post(ids.alice, { confirm: BOB });
    expect(wrong.status).toBe(422);
    const wrongBody = await wrong.json();
    expect(wrongBody.error.field).toBe('confirm');
    expect(JSON.stringify(wrongBody)).not.toContain(BOB);
    expect((await post(ids.alice, { confirm: 'x' })).status).toBe(422); // too short
    expect((await post(ids.alice, {})).status).toBe(422);
    expect((await post(ids.alice, { confirm: ALICE, extra: 1 })).status).toBe(422);
    expect((await post(ids.alice, { confirm: 42 })).status).toBe(422);
    expect((await post('usr_missing', { confirm: ALICE })).status).toBe(404);
    expect(await state(s)).toBe(before);
    expect(await actions(s)).not.toContain('user.unbind:ok');
    // An unbound user: nothing to clear.
    const unbound = await s.w.storage.users.create({
      id: 'usr_unbound',
      email: 'new@example.test',
      role: 'member',
    });
    expect((await post(unbound.id, { confirm: 'new@example.test' })).status).toBe(409);
  });

  it('lets exactly one of two concurrent unbinds win', async () => {
    const { s, owner, ids, second } = await env();
    const secondSession = await s.session('second@example.test');
    const [a, b] = await Promise.all([
      s.api('POST', `/users/${ids.alice}/unbind`, owner, { confirm: ALICE }),
      s.api('POST', `/users/${ids.alice}/unbind`, secondSession, { confirm: ALICE }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await unbindRows(s)).filter((r) => r.status === 'ok')).toHaveLength(1);
  });
});

describe('the panel: Move to another provider', () => {
  it('offers the button exactly when the admin API would allow it, for every viewer and target', async () => {
    const { s, owner, admin, ids, second } = await env();
    await s.w.storage.users.bind(second.id, 'oidc:corp', 'sub-second');
    let n = 0;
    const fresh = async (role: 'owner' | 'admin' | 'member', bound: boolean) => {
      n++;
      const u = await s.w.storage.users.create({ id: `usr_t${n}`, email: `t${n}@example.test`, role });
      if (bound) await s.w.storage.users.bind(u.id, 'oidc:corp', `sub-t${n}`);
      return u;
    };
    for (const [name, who] of [
      ['owner', owner],
      ['admin', admin],
    ] as const) {
      for (const role of ['owner', 'admin', 'member'] as const) {
        for (const bound of [true, false]) {
          const u = await fresh(role, bound);
          const doc = await (await page(s, `/admin/users/${u.id}`, who)).text();
          const api = await s.api('POST', `/users/${u.id}/unbind`, who, { confirm: u.email });
          expect(doc.includes(OFFER), `${name} on ${bound ? 'bound' : 'unbound'} ${role}`).toBe(
            api.status === 200,
          );
        }
      }
    }
    // Yourself: not offered, and the API refuses.
    const own = await (await page(s, `/admin/users/${ids.owner}`, owner)).text();
    expect(own.includes(OFFER)).toBe(false);
    expect((await s.api('POST', `/users/${ids.owner}/unbind`, owner, { confirm: OWNER })).status).toBe(403);
  });

  it('shows the warning page to owners only, never the subject, and a forged request from anyone else does nothing', async () => {
    const { s, owner, admin, alice, ids } = await env();
    const user = await s.w.storage.users.get(ids.alice);
    const res = await page(s, `/admin/users/${ids.alice}/unbind`, owner);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Account takeover risk');
    expect(html).toContain(`name="_csrf" value="${owner.csrf}"`);
    expect(html).not.toContain(user?.idpSubject as string);
    expect((await page(s, `/admin/users/${ids.alice}/unbind`, admin)).status).toBe(403);
    expect((await page(s, `/admin/users/${ids.alice}/unbind`, alice)).status).toBe(403);
    // The page is not offered for yourself.
    expect((await page(s, `/admin/users/${ids.owner}/unbind`, owner)).status).toBe(404);
    const before = await state(s);
    const fields = { confirm: 'yes', email: ALICE };
    expect((await submit(s, `/admin/users/${ids.alice}/unbind`, admin, fields)).status).toBe(403);
    expect((await submit(s, `/admin/users/${ids.alice}/unbind`, alice, fields)).status).toBe(403);
    expect(await state(s)).toBe(before);
    expect(await actions(s)).not.toContain('user.unbind:ok');
  });

  it('changes nothing without the confirmation and the right email, and never echoes what was typed', async () => {
    const { s, owner, ids } = await env();
    const before = await state(s);
    const typed = 'definitely-not-alice@example.test';
    for (const fields of [
      { email: ALICE },
      { confirm: 'yes' },
      { confirm: 'yes', email: '' },
      { confirm: 'yes', email: typed },
      { confirm: 'no', email: ALICE },
    ]) {
      const res = await submit(s, `/admin/users/${ids.alice}/unbind`, owner, fields);
      expect(res.status, JSON.stringify(fields)).toBe(422);
      expect(await res.text()).not.toContain(typed);
    }
    expect(await state(s)).toBe(before);
  });

  it('clears the identity from the page and ends the sessions; a stale sign-in goes through re-authentication first', async () => {
    const { s, owner, alice, ids } = await env();
    const fields = { confirm: 'yes', email: ALICE };
    s.w.now.t += 11 * MIN;
    const before = await state(s);
    const stale = await submit(s, `/admin/users/${ids.alice}/unbind`, owner, fields);
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain(
      `/auth/reauth?next=${encodeURIComponent(`/admin/users/${ids.alice}`)}`,
    );
    expect(await state(s)).toBe(before);
    const fresh = await s.session(OWNER);
    const done = await submit(s, `/admin/users/${ids.alice}/unbind`, fresh, fields);
    expect(done.status).toBe(303);
    expect(flashOf(done)).toBe('identity_cleared');
    expect(await s.w.storage.users.get(ids.alice)).toMatchObject({ idp: null, idpSubject: null });
    expect((await s.api('GET', '/users', alice)).status).toBe(401);
    const shown = await (await page(s, `/admin/users/${ids.alice}`, fresh)).text();
    expect(shown).toContain('not signed in yet');
    expect(shown).not.toContain(OFFER);
    expect((await unbindRows(s)).filter((r) => r.status === 'ok')).toHaveLength(1);
  });
});

describe('POST /users/{id}/unbind with a named provider (P4-24, THREAT_MODEL T14)', () => {
  const claimOf = (s: S, id: string) => s.w.storage.kv.get(`unbind-claim:${id}`);

  it('with a provider named, a verified sign-in at another provider cannot bind; the named one can, and the claim is spent', async () => {
    const { s, owner, ids } = await env();
    const res = await s.api('POST', `/users/${ids.alice}/unbind`, owner, {
      confirm: ALICE,
      provider: 'github',
      ttlMinutes: 30,
    });
    expect(res.status).toBe(200);
    expect(await claimOf(s, ids.alice)).toContain('github');
    // The configured provider here is oidc:corp: refused, nothing bound, no session, the claim stays.
    const refused = await s.signIn(ALICE, { claims: { sub: 'someone-else' } });
    expect(refused.status).not.toBe(200);
    expect(s.cookieOf(refused)).toBeUndefined();
    expect(await s.w.storage.users.get(ids.alice)).toMatchObject({ idp: null, idpSubject: null });
    expect(await claimOf(s, ids.alice)).not.toBeNull();
    // The audit row names the provider asked for, never the subject.
    const row = (await unbindRows(s)).find((r) => r.status === 'ok');
    expect(row?.details).toMatchObject({ requiredIdp: 'github', claimMinutes: 30 });
  });

  it('the named provider binds and clears the claim', async () => {
    const { s, owner, ids } = await env();
    expect(
      (await s.api('POST', `/users/${ids.alice}/unbind`, owner, { confirm: ALICE, provider: 'OIDC:corp' }))
        .status,
    ).toBe(200);
    const ok = await s.signIn(ALICE, { claims: { sub: 'new-subject' } });
    expect(ok.status).toBe(303);
    expect(await s.w.storage.users.get(ids.alice)).toMatchObject({ idpSubject: 'new-subject' });
    expect(await claimOf(s, ids.alice)).toBeNull();
  });

  it('without a provider the behaviour is as before, and a plain unbind clears an older claim', async () => {
    const { s, owner, ids } = await env();
    await s.api('POST', `/users/${ids.alice}/unbind`, owner, { confirm: ALICE, provider: 'github' });
    await s.w.storage.users.bind(ids.alice, 'oidc:corp', 'sub-again', {});
    expect((await s.api('POST', `/users/${ids.alice}/unbind`, owner, { confirm: ALICE })).status).toBe(200);
    expect(await claimOf(s, ids.alice)).toBeNull();
    expect((await s.signIn(ALICE, { claims: { sub: 'free' } })).status).toBe(303);
  });

  it('the claim expires', async () => {
    const { s, owner, ids } = await env();
    await s.api('POST', `/users/${ids.alice}/unbind`, owner, {
      confirm: ALICE,
      provider: 'github',
      ttlMinutes: 5,
    });
    expect((await s.signIn(ALICE, { claims: { sub: 'early' } })).status).not.toBe(303);
    s.w.now.t += 6 * MIN;
    expect((await s.signIn(ALICE, { claims: { sub: 'late' } })).status).toBe(303);
    expect(await s.w.storage.users.get(ids.alice)).toMatchObject({ idpSubject: 'late' });
  });

  it('refuses a bad provider or time, ttl without a provider, and writes nothing', async () => {
    const { s, owner, admin, ids } = await env();
    const post = (who: Session, body: Record<string, unknown>) =>
      s.api('POST', `/users/${ids.alice}/unbind`, who, { confirm: ALICE, ...body });
    const before = await state(s);
    for (const bad of [
      { provider: 'a b' },
      { provider: '' },
      { provider: 'x'.repeat(65) },
      { provider: 'github', ttlMinutes: 0 },
      { provider: 'github', ttlMinutes: 10_081 },
      { provider: 'github', ttlMinutes: 1.5 },
      { ttlMinutes: 10 },
    ]) {
      expect((await post(owner, bad)).status, JSON.stringify(bad)).toBe(422);
    }
    // Negative authorization: an admin cannot name a provider (or anything else) and no claim is left behind.
    expect((await post(admin, { provider: 'github' })).status).toBe(403);
    expect(await state(s)).toBe(before);
    expect(await claimOf(s, ids.alice)).toBeNull();
  });

  it('a failed unbind (already unbound) leaves no claim behind', async () => {
    const { s, owner, ids } = await env();
    await s.api('POST', `/users/${ids.alice}/unbind`, owner, { confirm: ALICE });
    await s.w.storage.kv.delete(`unbind-claim:${ids.alice}`);
    const again = await s.api('POST', `/users/${ids.alice}/unbind`, owner, {
      confirm: ALICE,
      provider: 'github',
    });
    expect(again.status).toBe(409);
    expect(await claimOf(s, ids.alice)).toBeNull();
  });

  it('the panel form passes the provider', async () => {
    const { s, owner, ids } = await env();
    const res = await submit(s, `/admin/users/${ids.alice}/unbind`, owner, {
      confirm: 'yes',
      email: ALICE,
      provider: 'github',
    });
    expect(res.status).toBe(303);
    expect(await claimOf(s, ids.alice)).toContain('github');
  });
});
