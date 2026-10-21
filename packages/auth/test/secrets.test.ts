// SPDX-License-Identifier: Apache-2.0
// Envelope encryption and master-key rotation (P2-03, ADR-0007, THREAT_MODEL T7).
import { createMemoryStorage, type Storage } from '@agility-bridge/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  generateMasterKey,
  KeyPurpose,
  Keyring,
  keyStatus,
  openCredentialToken,
  parseMasterKey,
  retireKeyVersion,
  rotateCredentialKeys,
  SecretsError,
  sealCredentialToken,
  tokenHint,
  verifyKeyring,
} from '../src/index.ts';

const TOKEN = '1.TestTokenNotRealAbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const K1 = generateMasterKey(1);
const K2 = generateMasterKey(2);

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SecretsError);
  expect((error as SecretsError).code).toBe(code);
}

describe('master keys', () => {
  it('parses v<N>:<base64>, bare base64 as version 1, and generates random 32-byte keys', () => {
    const parsed = parseMasterKey(K2);
    expect(parsed.version).toBe(2);
    expect(parsed.bytes).toHaveLength(32);
    expect(parseMasterKey(K1.slice(3)).version).toBe(1);
    expect(parseMasterKey(` ${K1}\n`).version).toBe(1);
    expect(generateMasterKey(7)).toMatch(/^v7:[A-Za-z0-9+/]{43}=$/);
    expect(new Set(Array.from({ length: 20 }, () => generateMasterKey())).size).toBe(20);
  });

  it('refuses malformed, short, long, versionless-zero and non-random keys without echoing them', () => {
    const body = K1.slice(3);
    const bad = [
      '',
      'v1:',
      body.slice(0, -2),
      `${body}AAAA`,
      `v0:${body}`,
      `v1000:${body}`,
      `x1:${body}`,
      `v1:${body.replace(/.$/, '!')}`,
      `v1:${'A'.repeat(43)}=`,
      'correct horse battery staple',
    ];
    for (const key of bad) {
      let error: unknown;
      try {
        parseMasterKey(key);
      } catch (e) {
        error = e;
      }
      expect(error, key).toBeInstanceOf(SecretsError);
      if (key.length > 4) expect((error as Error).message.includes(key.slice(3, 20))).toBe(false);
    }
  });

  it('a keyring takes a previous key only with a lower version and different material', async () => {
    await rejectsWith(Keyring.create(K1, K2), 'invalid_key');
    await rejectsWith(Keyring.create(K2, `v1:${K2.slice(3)}`), 'invalid_key');
    const ring = await Keyring.create(K2, K1);
    expect(ring.currentVersion).toBe(2);
    expect(ring.versions).toEqual([1, 2]);
    expect(ring.has(1)).toBe(true);
    expect(ring.has(3)).toBe(false);
  });
});

describe('sealing (AES-256-GCM)', () => {
  it('round-trips, with a fresh IV every time', async () => {
    const ring = await Keyring.create(K1);
    const sealed = await sealCredentialToken(ring, 'cred-1', TOKEN);
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.tokenHint).toBe('6789');
    expect(sealed.tokenCiphertext.includes(TOKEN.slice(2, 10))).toBe(false);
    expect(await openCredentialToken(ring, { id: 'cred-1', ...sealed })).toBe(TOKEN);
    const ivs = new Set<string>();
    for (let i = 0; i < 50; i++) ivs.add((await ring.seal(KeyPurpose.Credentials, 'c', 'x')).iv);
    expect(ivs.size).toBe(50);
    const unicode = `tökén-🔑-${'x'.repeat(20)}`;
    expect(
      await ring.open(KeyPurpose.Credentials, 'c', await ring.seal(KeyPurpose.Credentials, 'c', unicode)),
    ).toBe(unicode);
  });

  it('refuses a wrong key, tampered ciphertext or IV, another record id, another version or another purpose', async () => {
    const ring = await Keyring.create(K1);
    const sealed = await ring.seal(KeyPurpose.Credentials, 'cred-1', TOKEN);
    const other = await Keyring.create(generateMasterKey(1));
    await rejectsWith(other.open(KeyPurpose.Credentials, 'cred-1', sealed), 'decrypt_failed');
    const flip = (s: string) =>
      s[5] === 'A' ? `${s.slice(0, 5)}B${s.slice(6)}` : `${s.slice(0, 5)}A${s.slice(6)}`;
    await rejectsWith(
      ring.open(KeyPurpose.Credentials, 'cred-1', { ...sealed, ciphertext: flip(sealed.ciphertext) }),
      'decrypt_failed',
    );
    await rejectsWith(
      ring.open(KeyPurpose.Credentials, 'cred-1', { ...sealed, iv: flip(sealed.iv) }),
      'decrypt_failed',
    );
    await rejectsWith(
      ring.open(KeyPurpose.Credentials, 'cred-1', { ...sealed, iv: 'AAAA' }),
      'decrypt_failed',
    );
    await rejectsWith(
      ring.open(KeyPurpose.Credentials, 'cred-1', { ...sealed, ciphertext: 'a+b/' }),
      'decrypt_failed',
    );
    // Wrong additional data: the ciphertext of another credential, or the label of another version.
    await rejectsWith(ring.open(KeyPurpose.Credentials, 'cred-2', sealed), 'decrypt_failed');
    const both = await Keyring.create(K2, K1);
    const v2 = await both.seal(KeyPurpose.Credentials, 'cred-1', TOKEN);
    await rejectsWith(
      both.open(KeyPurpose.Credentials, 'cred-1', { ...v2, keyVersion: 1 }),
      'decrypt_failed',
    );
    await rejectsWith(ring.open(KeyPurpose.Approval, 'cred-1', sealed), 'decrypt_failed');
    await rejectsWith(
      ring.open(KeyPurpose.Credentials, 'cred-1', { ...sealed, keyVersion: 9 }),
      'key_unavailable',
    );
  });

  it('keyed hashes differ per purpose and version and never equal the key-check value', async () => {
    const ring = await Keyring.create(K2, K1);
    const a = await ring.mac(KeyPurpose.AuditIdentity, 'x');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await ring.mac(KeyPurpose.AuditIdentity, 'x')).toBe(a);
    expect(await ring.mac(KeyPurpose.AuditIdentity, 'x', 1)).not.toBe(a);
    expect(await ring.mac(KeyPurpose.CacheId, 'x')).not.toBe(a);
    expect(await ring.keyCheckValue(2)).not.toBe(await ring.keyCheckValue(1));
    await expect(ring.seal(KeyPurpose.KeyCheck, 'x', 'y')).rejects.toThrow(TypeError);
    await expect(ring.mac(KeyPurpose.Credentials, 'x')).rejects.toThrow(TypeError);
  });

  it('hints show at most the last four characters, and nothing of short values', () => {
    expect(tokenHint(TOKEN)).toBe('6789');
    expect(tokenHint('short-token')).toBe('');
  });
});

describe('key-check values and rotation', () => {
  let storage: Storage;
  let t: number;

  beforeEach(async () => {
    t = 1_760_000_000_000;
    storage = createMemoryStorage({ now: () => t });
    await storage.instances.create({ id: 'i', label: 'i', baseUrl: 'https://agility.example.test/x' });
  });

  async function addCredentials(ring: Keyring, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `c-${i}`;
      const sealed = await sealCredentialToken(ring, id, `${TOKEN}-${i}`);
      await storage.credentials.create({ id, instanceId: 'i', label: id, ...sealed });
      ids.push(id);
    }
    return ids;
  }

  it('records a key-check value per version and refuses a different key for a known version', async () => {
    const v1 = await Keyring.create(K1);
    expect((await verifyKeyring(storage, v1)).warnings).toEqual([]);
    expect((await verifyKeyring(storage, v1)).warnings).toEqual([]);
    await rejectsWith(verifyKeyring(storage, await Keyring.create(generateMasterKey(1))), 'wrong_key');
    // A rotation to v2 records v2; later reusing "v2" for other material is refused even as the previous key.
    await verifyKeyring(storage, await Keyring.create(K2, K1));
    await rejectsWith(
      verifyKeyring(storage, await Keyring.create(generateMasterKey(3), generateMasterKey(2))),
      'wrong_key',
    );
    const stored = JSON.stringify(await storage.kv.list('crypto:'));
    expect(stored.includes(K1.slice(3, 15))).toBe(false);
  });

  it('rotates every credential to the current key; the old key is then unnecessary', async () => {
    const v1 = await Keyring.create(K1);
    await verifyKeyring(storage, v1);
    await addCredentials(v1, 5);
    const ring = await Keyring.create(K2, K1);
    const result = await rotateCredentialKeys(storage, ring, {
      reason: 'scheduled',
      batchSize: 2,
      actor: { via: 'cli' },
    });
    expect(result).toEqual({ rotated: 5, skipped: 0, failed: [], remaining: 0 });
    const v2Only = await Keyring.create(K2);
    for (const c of await storage.credentials.list()) {
      expect(c.keyVersion).toBe(2);
      expect(await openCredentialToken(v2Only, c)).toBe(`${TOKEN}-${c.id.slice(2)}`);
    }
    const audit = await storage.audit.query({ limit: 100 });
    expect(audit).toHaveLength(5);
    expect(audit[0]).toMatchObject({
      kind: 'admin',
      action: 'credential.rekey',
      status: 'ok',
      targetType: 'credential',
      details: { fromVersion: 1, toVersion: 2, reason: 'scheduled', via: 'cli' },
    });
    const dump = JSON.stringify(audit);
    for (const secret of [TOKEN.slice(2, 20), K1.slice(3, 20), K2.slice(3, 20)])
      expect(dump.includes(secret)).toBe(false);
    expect(await keyStatus(storage, ring)).toEqual([
      { version: 1, credentials: 0, loaded: true, current: false, retired: false },
      { version: 2, credentials: 5, loaded: true, current: true, retired: false },
    ]);
  });

  it('an interrupted rotation resumes where it stopped', async () => {
    await addCredentials(await Keyring.create(K1), 6);
    const ring = await Keyring.create(K2, K1);
    let calls = 0;
    const crashing: Storage = {
      ...storage,
      credentials: {
        ...storage.credentials,
        replaceSecret: async (...args) => {
          if (++calls === 4) throw new Error('process killed');
          return storage.credentials.replaceSecret(...args);
        },
      },
    };
    await expect(rotateCredentialKeys(crashing, ring, { reason: 'scheduled', batchSize: 2 })).rejects.toThrow(
      'process killed',
    );
    const mid = await keyStatus(storage, ring);
    expect(mid.map((v) => v.credentials)).toEqual([3, 3]);
    const partial = await rotateCredentialKeys(storage, ring, {
      reason: 'resume',
      batchSize: 1,
      maxBatches: 1,
    });
    expect(partial).toMatchObject({ rotated: 1, remaining: 2 });
    expect(await rotateCredentialKeys(storage, ring, { reason: 'resume' })).toMatchObject({
      rotated: 2,
      remaining: 0,
    });
    const v2Only = await Keyring.create(K2);
    for (const c of await storage.credentials.list()) await openCredentialToken(v2Only, c);
  });

  it('a row changed during the rotation is skipped, not overwritten, and picked up by the next run', async () => {
    const v1 = await Keyring.create(K1);
    await addCredentials(v1, 2);
    const ring = await Keyring.create(K2, K1);
    const racing: Storage = {
      ...storage,
      credentials: {
        ...storage.credentials,
        replaceSecret: async (id, expected, next) => {
          if (id === 'c-0') {
            // A member re-enters their token between the read and the swap.
            const fresh = await sealCredentialToken(v1, 'c-0', 'a-brand-new-token-value');
            await storage.credentials.replaceSecret(id, expected, fresh);
          }
          return storage.credentials.replaceSecret(id, expected, next);
        },
      },
    };
    expect(await rotateCredentialKeys(racing, ring, { reason: 'x' })).toMatchObject({
      rotated: 1,
      skipped: 1,
    });
    expect(await rotateCredentialKeys(storage, ring, { reason: 'x' })).toMatchObject({
      rotated: 1,
      remaining: 0,
    });
    const c0 = await storage.credentials.get('c-0');
    expect(await openCredentialToken(ring, c0 as NonNullable<typeof c0>)).toBe('a-brand-new-token-value');
  });

  it('reports rows it cannot decrypt or whose key is not loaded, and audits the failures', async () => {
    await addCredentials(await Keyring.create(K1), 1);
    const v3 = await Keyring.create(generateMasterKey(3));
    const lost = await sealCredentialToken(v3, 'c-lost', TOKEN);
    await storage.credentials.create({ id: 'c-lost', instanceId: 'i', label: 'lost', ...lost });
    await storage.credentials.create({
      id: 'c-bad',
      instanceId: 'i',
      label: 'bad',
      ...(await sealCredentialToken(await Keyring.create(K1), 'another-id', TOKEN)),
    });
    const ring = await Keyring.create(K2, K1);
    const result = await rotateCredentialKeys(storage, ring, { reason: 'x' });
    expect(result.rotated).toBe(1);
    expect(result.failed).toEqual(
      expect.arrayContaining([
        { id: 'c-lost', keyVersion: 3, reason: 'key_unavailable' },
        { id: 'c-bad', keyVersion: 1, reason: 'decrypt_failed' },
      ]),
    );
    expect(result.remaining).toBe(2);
    expect(await storage.audit.query({ status: 'error' })).toHaveLength(2);
    expect((await verifyKeyring(storage, ring)).warnings).toEqual([expect.stringContaining('version 3')]);
  });

  it('retires a version only when unused; a retired version cannot be the current key again', async () => {
    const v1 = await Keyring.create(K1);
    await verifyKeyring(storage, v1);
    await addCredentials(v1, 2);
    const ring = await Keyring.create(K2, K1);
    await verifyKeyring(storage, ring);
    await rejectsWith(retireKeyVersion(storage, ring, 1, { reason: 'done' }), 'in_use');
    await rejectsWith(retireKeyVersion(storage, ring, 2, { reason: 'done' }), 'in_use');
    await rotateCredentialKeys(storage, ring, { reason: 'scheduled' });
    t += 1_000;
    await retireKeyVersion(storage, ring, 1, { reason: 'rotation finished', now: () => t });
    expect((await verifyKeyring(storage, ring)).warnings).toEqual([
      expect.stringContaining('remove AB_MASTER_KEY_PREVIOUS'),
    ]);
    expect((await verifyKeyring(storage, await Keyring.create(K2))).warnings).toEqual([]);
    await rejectsWith(verifyKeyring(storage, v1), 'retired');
    expect(
      (await storage.audit.query({ limit: 100 })).find((a) => a.action === 'crypto.retire_key'),
    ).toMatchObject({
      action: 'crypto.retire_key',
      targetId: '1',
    });
  });
});
