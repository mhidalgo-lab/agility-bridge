// SPDX-License-Identifier: Apache-2.0
// Sign-in transactions and setup links in storage (P4-01): consumed exactly once, bound to one browser and provider,
// expiring, and holding nothing an attacker with a copy of the database could replay (L-073, L-085).
import { createMemoryStorage, type Storage } from '@agility-bridge/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  consumeSetupLink,
  createSetupLink,
  finishLogin,
  generateMasterKey,
  isIdentityError,
  Keyring,
  LOGIN_TTL_SECONDS,
  MAX_SETUP_LINK_TTL_MS,
  pkceChallenge,
  SETUP_CODE_RE,
  setupCodeHash,
  setupLinkUsable,
  startLogin,
} from '../../src/index.ts';

const now = { t: Date.UTC(2026, 9, 23, 12) };
const clock = { now: () => now.t };
let storage: Storage;
let keyring: Keyring;

beforeEach(async () => {
  now.t = Date.UTC(2026, 9, 23, 12);
  storage = createMemoryStorage({ now: clock.now });
  keyring = await Keyring.create(generateMasterKey(1));
});

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (error) {
    if (isIdentityError(error)) return error.code;
    throw error;
  }
}

const start = (provider = 'google', setup: string | null = null, next = '/admin') =>
  startLogin(storage.kv, keyring, { provider, next, setup }, clock);

describe('login transactions', () => {
  it('round-trips: the callback gets the verifier and nonce whose challenge and value the IdP saw', async () => {
    const started = await start('google', null, '/admin/users');
    const tx = await finishLogin(
      storage.kv,
      keyring,
      { state: started.state, binding: started.binding, provider: 'google' },
      clock,
    );
    expect(tx.nonce).toBe(started.nonce);
    expect(await pkceChallenge(tx.codeVerifier)).toBe(started.codeChallenge);
    expect(tx).toMatchObject({ provider: 'google', next: '/admin/users', setup: null });
    // RFC 7636: 43-128 unreserved characters.
    expect(tx.codeVerifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
  });

  it('derives a different verifier and nonce for every login', async () => {
    const a = await start();
    const b = await start();
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('is single use: a replayed state finds nothing', async () => {
    const s = await start();
    const input = { state: s.state, binding: s.binding, provider: 'google' };
    await finishLogin(storage.kv, keyring, input, clock);
    expect(await reason(finishLogin(storage.kv, keyring, input, clock))).toBe('unknown_state');
  });

  it('is consumed once under parallel callbacks', async () => {
    const s = await start();
    const input = { state: s.state, binding: s.binding, provider: 'google' };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reason(finishLogin(storage.kv, keyring, input, clock))),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'unknown_state')).toHaveLength(9);
  });

  it('is consumed even when the callback is refused, so a wrong cookie cannot be retried with the right one', async () => {
    const s = await start();
    expect(
      await reason(
        finishLogin(storage.kv, keyring, { state: s.state, binding: undefined, provider: 'google' }, clock),
      ),
    ).toBe('binding_mismatch');
    expect(
      await reason(
        finishLogin(storage.kv, keyring, { state: s.state, binding: s.binding, provider: 'google' }, clock),
      ),
    ).toBe('unknown_state');
  });

  it('refuses a callback from another browser (login CSRF), with no cookie, a forged one or a malformed one', async () => {
    const mine = await start();
    const theirs = await start();
    for (const binding of [undefined, '', 'short', theirs.binding, 'a'.repeat(43), `${mine.binding}x`]) {
      const s = await start();
      expect(
        await reason(
          finishLogin(storage.kv, keyring, { state: s.state, binding, provider: 'google' }, clock),
        ),
        String(binding),
      ).toBe('binding_mismatch');
    }
    expect(
      await reason(
        finishLogin(
          storage.kv,
          keyring,
          { state: mine.state, binding: mine.binding, provider: 'google' },
          clock,
        ),
      ),
    ).toBe('ok');
  });

  it('refuses a transaction of provider A at the callback of provider B (mix-up)', async () => {
    const s = await start('google');
    expect(
      await reason(
        finishLogin(storage.kv, keyring, { state: s.state, binding: s.binding, provider: 'github' }, clock),
      ),
    ).toBe('provider_mismatch');
  });

  it('refuses malformed, missing and unknown states before any guess is useful', async () => {
    const s = await start();
    for (const state of [undefined, '', 'x', 'a'.repeat(43), `${s.state}!`, s.state.slice(1)]) {
      const outcome = await reason(
        finishLogin(storage.kv, keyring, { state, binding: s.binding, provider: 'google' }, clock),
      );
      expect(['invalid_callback', 'unknown_state'], String(state)).toContain(outcome);
    }
  });

  it('expires after ten minutes, in storage and by its own timestamp', async () => {
    const a = await start();
    now.t += (LOGIN_TTL_SECONDS + 1) * 1000;
    expect(
      await reason(
        finishLogin(storage.kv, keyring, { state: a.state, binding: a.binding, provider: 'google' }, clock),
      ),
    ).toBe('unknown_state');
    const b = await start();
    now.t += (LOGIN_TTL_SECONDS - 1) * 1000;
    expect(
      await reason(
        finishLogin(storage.kv, keyring, { state: b.state, binding: b.binding, provider: 'google' }, clock),
      ),
    ).toBe('ok');
  });

  it('stores no secret: not the state, binding, verifier or nonce, and nothing that recovers them without the key', async () => {
    const s = await start('google', null, '/admin');
    const keys = await storage.kv.list('login:');
    expect(keys).toHaveLength(1);
    const stored = (await storage.kv.get(keys[0] as string)) as string;
    const tx = await finishLogin(
      storage.kv,
      keyring,
      { state: s.state, binding: s.binding, provider: 'google' },
      clock,
    );
    for (const secret of [s.state, s.binding, s.nonce, tx.codeVerifier, s.codeChallenge]) {
      expect(stored).not.toContain(secret);
      expect(keys.join()).not.toContain(secret);
    }
    // And a different master key derives different secrets from the same state.
    const other = await Keyring.create(generateMasterKey(1));
    const s2 = await start();
    await expect(
      finishLogin(storage.kv, other, { state: s2.state, binding: s2.binding, provider: 'google' }, clock),
    ).resolves.not.toMatchObject({ nonce: s2.nonce });
  });

  it('survives a master-key rotation that keeps the old key, and fails closed once it is gone', async () => {
    const v1 = generateMasterKey(1);
    const old = await Keyring.create(v1);
    const s = await startLogin(storage.kv, old, { provider: 'google', next: '/admin', setup: null }, clock);
    const rotated = await Keyring.create(generateMasterKey(2), v1);
    const tx = await finishLogin(
      storage.kv,
      rotated,
      { state: s.state, binding: s.binding, provider: 'google' },
      clock,
    );
    expect(tx.nonce).toBe(s.nonce);
    const s2 = await startLogin(storage.kv, old, { provider: 'google', next: '/admin', setup: null }, clock);
    const lost = await Keyring.create(generateMasterKey(2));
    expect(
      await reason(
        finishLogin(storage.kv, lost, { state: s2.state, binding: s2.binding, provider: 'google' }, clock),
      ),
    ).toBe('unknown_state');
  });
});

describe('setup links', () => {
  it('creates a 256-bit code, stored only as a hash', async () => {
    const link = await createSetupLink(storage.kv, 60 * 60_000, clock);
    expect(link.code).toMatch(SETUP_CODE_RE);
    expect(link.expiresAt).toBe(now.t + 60 * 60_000);
    const keys = await storage.kv.list('setup:');
    expect(keys).toEqual([`setup:${await setupCodeHash(link.code)}`]);
    expect(keys.join()).not.toContain(link.code);
    expect(await storage.kv.get(keys[0] as string)).not.toContain(link.code);
  });

  it('is single use under parallel completions', async () => {
    const link = await createSetupLink(storage.kv, 60 * 60_000, clock);
    const hash = (await setupCodeHash(link.code)) as string;
    expect(await setupLinkUsable(storage.kv, hash, clock)).toBe(true);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => consumeSetupLink(storage.kv, hash, clock)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await setupLinkUsable(storage.kv, hash, clock)).toBe(false);
  });

  it('expires', async () => {
    const link = await createSetupLink(storage.kv, 60_000, clock);
    const hash = (await setupCodeHash(link.code)) as string;
    now.t += 59_000;
    expect(await setupLinkUsable(storage.kv, hash, clock)).toBe(true);
    now.t += 2_000;
    expect(await setupLinkUsable(storage.kv, hash, clock)).toBe(false);
    expect(await consumeSetupLink(storage.kv, hash, clock)).toBe(false);
  });

  it('limits its lifetime to one minute through seven days', async () => {
    for (const ttl of [0, 59_999, MAX_SETUP_LINK_TTL_MS + 1, Number.NaN, 1.5]) {
      await expect(createSetupLink(storage.kv, ttl, clock), String(ttl)).rejects.toThrow(RangeError);
    }
    await createSetupLink(storage.kv, 60_000, clock);
    await createSetupLink(storage.kv, MAX_SETUP_LINK_TTL_MS, clock);
  });

  it('answers a malformed or unknown code without touching storage', async () => {
    for (const bad of [
      undefined,
      '',
      'ab_setup_',
      `ab_setup_${'g'.repeat(64)}`,
      `ab_setup_${'a'.repeat(63)}`,
      `AB_SETUP_${'a'.repeat(64)}`,
    ]) {
      expect(await setupCodeHash(bad), String(bad)).toBeNull();
    }
    const unknown = (await setupCodeHash(`ab_setup_${'a'.repeat(64)}`)) as string;
    expect(await setupLinkUsable(storage.kv, unknown, clock)).toBe(false);
    expect(await consumeSetupLink(storage.kv, unknown, clock)).toBe(false);
  });

  it('one link serves one login: the transaction carries only the hash', async () => {
    const link = await createSetupLink(storage.kv, 60_000, clock);
    const hash = (await setupCodeHash(link.code)) as string;
    const s = await start('google', hash);
    const tx = await finishLogin(
      storage.kv,
      keyring,
      { state: s.state, binding: s.binding, provider: 'google' },
      clock,
    );
    expect(tx.setup).toBe(hash);
    const stored = JSON.stringify(
      await Promise.all((await storage.kv.list('login:')).map((k) => storage.kv.get(k))),
    );
    expect(stored).not.toContain(link.code);
  });
});
