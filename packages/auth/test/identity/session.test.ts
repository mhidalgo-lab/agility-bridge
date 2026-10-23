// SPDX-License-Identifier: Apache-2.0
// Admin sessions in storage (P4-02, THREAT_MODEL T13): hash-only, idle and absolute expiry on an injected clock, the
// per-user cap, rotation support, and ending sessions in a bounded number of storage calls.
import { createMemoryStorage, type Storage } from '@agility-bridge/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkSessionTimeouts,
  createSession,
  csrfTokenMatches,
  DEFAULT_SESSION_TIMEOUTS,
  isRecentAuth,
  loadSession,
  parseSessionCookie,
  RECENT_AUTH_WINDOW_MS,
  revokeSession,
  revokeUserSessions,
  SESSION_TOUCH_INTERVAL_MS,
} from '../../src/index.ts';

const MIN = 60_000;
const now = { t: Date.UTC(2026, 9, 23, 12) };
const clock = { now: () => now.t };
let storage: Storage;

beforeEach(() => {
  now.t = Date.UTC(2026, 9, 23, 12);
  storage = createMemoryStorage({ now: clock.now });
});

const T = DEFAULT_SESSION_TIMEOUTS;
const make = (userId = 'usr_1', max?: number) =>
  createSession(storage.kv, { userId, provider: 'github', idp: 'github' }, T, clock, max);
const load = (cookie: string | undefined) => loadSession(storage.kv, cookie, T, clock);
const reason = async (cookie: string | undefined) => {
  const r = await load(cookie);
  return r.ok ? 'ok' : r.reason;
};

describe('session storage', () => {
  it('stores only a hash of the secret, never the secret, the cookie or a role', async () => {
    const s = await make();
    const secret = s.cookieValue.slice(s.cookieValue.lastIndexOf('.') + 1);
    const keys = await storage.kv.list('');
    expect(keys.sort()).toEqual([`sess-seen:usr_1:${s.hash}`, `sess:usr_1:${s.hash}`].sort());
    for (const key of keys) {
      expect(key).not.toContain(secret);
      expect((await storage.kv.get(key)) ?? '').not.toContain(secret);
    }
    const row = JSON.parse((await storage.kv.get(`sess:usr_1:${s.hash}`)) as string);
    expect(Object.keys(row).sort()).toEqual(['createdAt', 'csrf', 'expiresAt', 'idp', 'provider', 'userId']);
    expect(row.csrf).not.toBe(secret);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('loads a live session and refuses malformed, unknown and foreign cookies without a storage read', async () => {
    const s = await make();
    expect(await reason(s.cookieValue)).toBe('ok');
    for (const bad of [
      undefined,
      '',
      'nodot',
      '.x',
      `usr_1.short`,
      `usr 1.${'a'.repeat(43)}`,
      'x'.repeat(200),
    ]) {
      expect(await reason(bad), String(bad)).toBe('session_malformed');
    }
    // The right secret under another user's id names no session.
    const secret = s.cookieValue.split('.')[1];
    expect(await reason(`usr_2.${secret}`)).toBe('session_unknown');
    expect(await reason(`usr_1.${'A'.repeat(43)}`)).toBe('session_unknown');
    expect(parseSessionCookie(`usr_1.${secret}`)?.userId).toBe('usr_1');
  });

  it('ends a session after the idle timeout, exactly at the boundary', async () => {
    const s = await make();
    now.t += T.idleMs - 1;
    expect(await reason(s.cookieValue)).toBe('ok');
    now.t += T.idleMs; // last activity was refreshed one idle period ago
    expect(await reason(s.cookieValue)).toBe('session_idle');
    const s2 = await make('usr_2');
    now.t += T.idleMs;
    expect(await reason(s2.cookieValue)).toBe('session_idle');
  });

  it('ends a session at its absolute lifetime however active it is, and activity never extends it', async () => {
    const s = await make();
    const end = s.record.expiresAt;
    while (now.t + 20 * MIN < end) {
      now.t += 20 * MIN;
      expect(await reason(s.cookieValue)).toBe('ok');
    }
    now.t = end - 1;
    expect(await reason(s.cookieValue)).toBe('ok');
    now.t = end;
    expect(await reason(s.cookieValue)).toBe('session_expired');
    const row = JSON.parse((await storage.kv.get(`sess:usr_1:${s.hash}`)) as string);
    expect(row.expiresAt).toBe(end);
  });

  it('writes activity at most once a minute', async () => {
    const s = await make();
    const seen = `sess-seen:usr_1:${s.hash}`;
    now.t += SESSION_TOUCH_INTERVAL_MS - 1;
    await load(s.cookieValue);
    expect(await storage.kv.get(seen)).toBe(String(s.lastSeenAt));
    now.t += 1;
    await load(s.cookieValue);
    expect(await storage.kv.get(seen)).toBe(String(now.t));
  });

  it('a refresh racing a logout cannot bring the session back', async () => {
    const s = await make();
    await revokeSession(storage.kv, s.cookieValue);
    await storage.kv.set(`sess-seen:usr_1:${s.hash}`, String(now.t)); // the late activity write
    expect(await reason(s.cookieValue)).toBe('session_unknown');
  });

  it('logout ends one session and leaves the user other ones', async () => {
    const a = await make();
    const b = await make();
    expect(await revokeSession(storage.kv, a.cookieValue)).toBe(true);
    expect(await revokeSession(storage.kv, a.cookieValue)).toBe(false);
    expect(await revokeSession(storage.kv, 'garbage')).toBe(false);
    expect(await reason(a.cookieValue)).toBe('session_unknown');
    expect(await reason(b.cookieValue)).toBe('ok');
  });

  it('caps live sessions per user by ending the oldest', async () => {
    const issued = [];
    for (let i = 0; i < 3; i++) {
      issued.push(await make('usr_1', 3));
      now.t += 1_000;
    }
    const other = await make('usr_2', 3);
    const fourth = await make('usr_1', 3);
    expect(fourth.evicted).toBe(1);
    expect(await reason(issued[0]?.cookieValue)).toBe('session_unknown');
    expect(await reason(issued[1]?.cookieValue)).toBe('ok');
    expect(await reason(issued[2]?.cookieValue)).toBe('ok');
    expect(await reason(fourth.cookieValue)).toBe('ok');
    expect(await reason(other.cookieValue)).toBe('ok');
    expect(await storage.kv.list('sess:usr_1:')).toHaveLength(3);
  });

  it('one user id that prefixes another is not touched when the first is ended', async () => {
    const a = await make('usr_1');
    const b = await make('usr_10');
    expect(await revokeUserSessions(storage.kv, 'usr_1')).toBe(1);
    expect(await reason(a.cookieValue)).toBe('session_unknown');
    expect(await reason(b.cookieValue)).toBe('ok');
  });

  it('ends a thousand sessions in two storage calls', async () => {
    for (let i = 0; i < 1000; i++) {
      const hash = i.toString(16).padStart(64, '0');
      await storage.kv.set(`sess:usr_1:${hash}`, '{}');
      await storage.kv.set(`sess-seen:usr_1:${hash}`, '1');
    }
    const keep = await make('usr_2');
    let calls = 0;
    const counting = new Proxy(storage.kv, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function'
          ? (...args: unknown[]) => {
              calls++;
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            }
          : value;
      },
    });
    expect(await revokeUserSessions(counting, 'usr_1')).toBe(1000);
    expect(calls).toBe(2);
    expect(await storage.kv.list('sess:usr_1:')).toEqual([]);
    expect(await storage.kv.list('sess-seen:usr_1:')).toEqual([]);
    expect(await reason(keep.cookieValue)).toBe('ok');
  });

  it('an over-full user is ended in one go at the next sign-in', async () => {
    for (let i = 0; i < 40; i++) {
      await storage.kv.set(`sess:usr_1:${i.toString(16).padStart(64, '0')}`, '{}');
    }
    const s = await make('usr_1', 5);
    expect(s.evicted).toBe(40);
    expect(await storage.kv.list('sess:usr_1:')).toHaveLength(1);
  });

  it('rejects a user id that could escape the key layout, and bad caps', async () => {
    for (const id of ['a:b', 'a b', '', 'x'.repeat(65)]) {
      await expect(make(id)).rejects.toThrow(TypeError);
    }
    await expect(make('usr_1', 0)).rejects.toThrow(RangeError);
    await expect(make('usr_1', 101)).rejects.toThrow(RangeError);
  });
});

describe('recent sign-in and CSRF tokens', () => {
  it('a sign-in is recent for ten minutes, exclusive at the boundary, and never from the future', () => {
    expect(RECENT_AUTH_WINDOW_MS).toBe(10 * MIN);
    expect(isRecentAuth(1_000, 1_000)).toBe(true);
    expect(isRecentAuth(1_000, 1_000 + 10 * MIN - 1)).toBe(true);
    expect(isRecentAuth(1_000, 1_000 + 10 * MIN)).toBe(false);
    expect(isRecentAuth(2_000, 1_000)).toBe(false);
  });

  it('compares the CSRF token exactly', async () => {
    const s = await make();
    const { csrf } = s.record;
    expect(csrfTokenMatches(s.record, csrf)).toBe(true);
    expect(csrfTokenMatches(s.record, undefined)).toBe(false);
    expect(csrfTokenMatches(s.record, '')).toBe(false);
    expect(csrfTokenMatches(s.record, csrf.slice(0, -1))).toBe(false);
    expect(csrfTokenMatches(s.record, `${csrf.slice(0, -1)}${csrf.endsWith('A') ? 'B' : 'A'}`)).toBe(false);
    expect(csrfTokenMatches(s.record, `${csrf} `)).toBe(false);
    const other = await make('usr_2');
    expect(csrfTokenMatches(s.record, other.record.csrf)).toBe(false);
  });

  it('checks the timeouts it is given', () => {
    expect(() => checkSessionTimeouts({ idleMs: MIN, absoluteMs: 12 * 60 * MIN })).toThrow(RangeError);
    expect(() => checkSessionTimeouts({ idleMs: 30 * MIN, absoluteMs: 30 * MIN })).toThrow(RangeError);
    expect(() => checkSessionTimeouts({ idleMs: 90 * MIN, absoluteMs: 60 * MIN })).toThrow(RangeError);
    expect(checkSessionTimeouts({ idleMs: 30 * MIN, absoluteMs: 60 * MIN }).idleMs).toBe(30 * MIN);
  });
});
