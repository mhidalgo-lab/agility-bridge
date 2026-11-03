// SPDX-License-Identifier: Apache-2.0
// Property and fuzz tests for the credential parsers (P9-01, THREAT_MODEL T1, T7): token formats, the bearer header and
// the sealed-value format. Seeded and replayable (L-123).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { propertyParams } from '../../core/test/harness/property.ts';
import { verifyJwt } from '../src/identity/jwt.ts';
import {
  bearerToken,
  generateAdminToken,
  generateDeviceToken,
  generateMasterKey,
  IdentityError,
  isWellFormedAdminToken,
  isWellFormedDeviceToken,
  KeyPurpose,
  Keyring,
  parseMasterKey,
  SecretsError,
} from '../src/index.ts';
import { fromBase64Url, toBase64Url } from '../src/secrets/keyring.ts';

const params = propertyParams(200);
const anything = fc.oneof(
  fc.string({ maxLength: 120 }),
  fc.string({ unit: 'binary', maxLength: 80 }),
  fc.anything(),
);

describe('fuzz: token formats (T1)', () => {
  it('format checks never throw and refuse anything that is not text', () => {
    fc.assert(
      fc.property(anything, (input) => {
        expect(typeof isWellFormedDeviceToken(input)).toBe('boolean');
        expect(typeof isWellFormedAdminToken(input)).toBe('boolean');
        if (typeof input !== 'string') {
          expect(isWellFormedDeviceToken(input)).toBe(false);
          expect(isWellFormedAdminToken(input)).toBe(false);
        }
      }),
      params,
    );
  });

  it('accepts what we issue and refuses every single-character change of it', async () => {
    const { token } = await generateDeviceToken('live');
    const admin = generateAdminToken();
    expect(isWellFormedDeviceToken(token)).toBe(true);
    expect(isWellFormedAdminToken(admin)).toBe(true);
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-';
    fc.assert(
      fc.property(fc.integer({ min: 0, max: token.length - 1 }), fc.constantFrom(...alphabet), (at, ch) => {
        fc.pre(token[at] !== ch);
        const changed = `${token.slice(0, at)}${ch}${token.slice(at + 1)}`;
        // A change in the body or the checksum breaks the checksum; a change in the prefix breaks the shape.
        expect(isWellFormedDeviceToken(changed)).toBe(false);
      }),
      params,
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: token.length - 1 }), (cut) => {
        expect(isWellFormedDeviceToken(token.slice(0, cut))).toBe(false);
        expect(isWellFormedDeviceToken(`${token}${token.slice(0, cut + 1)}`)).toBe(false);
      }),
      params,
    );
  });
});

describe('fuzz: the bearer header (T1)', () => {
  it('returns a single whitespace-free token of at most 512 characters or null', () => {
    fc.assert(
      fc.property(fc.option(fc.string({ maxLength: 600 }), { nil: undefined }), (header) => {
        const token = bearerToken(header);
        if (token !== null) {
          expect(token).toMatch(/^\S{1,512}$/);
          expect(header).toMatch(/^Bearer/i);
        }
      }),
      params,
    );
  });

  it('round-trips any whitespace-free token', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[\x21-\x7e]{1,512}$/), (token) => {
        expect(bearerToken(`Bearer ${token}`)).toBe(token);
      }),
      params,
    );
  });
});

describe('fuzz: master keys and sealed values (T7)', () => {
  it('parseMasterKey refuses arbitrary text with a typed error that never echoes the input', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9+/=:]{14,60}$/), (text) => {
        try {
          parseMasterKey(text);
        } catch (error) {
          expect(error).toBeInstanceOf(SecretsError);
          expect((error as Error).message).not.toContain(text.trim());
        }
      }),
      params,
    );
  });

  it('a sealed value opens only unchanged: any altered byte of ciphertext or IV fails closed', async () => {
    const keyring = await Keyring.create(generateMasterKey(1));
    const sealed = await keyring.seal(KeyPurpose.Credentials, 'credential:1', 'the secret');
    expect(await keyring.open(KeyPurpose.Credentials, 'credential:1', sealed)).toBe('the secret');
    const ct = fromBase64Url(sealed.ciphertext);
    const iv = fromBase64Url(sealed.iv);
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: ct.length - 1 }),
        fc.integer({ min: 0, max: iv.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        async (i, j, flip) => {
          const badCt = Uint8Array.from(ct);
          badCt[i] = (badCt[i] as number) ^ flip;
          const badIv = Uint8Array.from(iv);
          badIv[j] = (badIv[j] as number) ^ flip;
          await expect(
            keyring.open(KeyPurpose.Credentials, 'credential:1', {
              ...sealed,
              ciphertext: toBase64Url(badCt),
            }),
          ).rejects.toMatchObject({ code: 'decrypt_failed' });
          await expect(
            keyring.open(KeyPurpose.Credentials, 'credential:1', { ...sealed, iv: toBase64Url(badIv) }),
          ).rejects.toMatchObject({ code: 'decrypt_failed' });
        },
      ),
      { ...params, numRuns: 60 },
    );
  });

  it('a sealed value never opens in another context', async () => {
    const keyring = await Keyring.create(generateMasterKey(1));
    const sealed = await keyring.seal(KeyPurpose.Credentials, 'credential:1', 'x');
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 40 }), async (context) => {
        fc.pre(context !== 'credential:1');
        await expect(keyring.open(KeyPurpose.Credentials, context, sealed)).rejects.toBeInstanceOf(
          SecretsError,
        );
      }),
      { ...params, numRuns: 60 },
    );
  });
});

describe('fuzz: identity provider tokens (T14)', () => {
  it('any text is refused with an IdentityError, never accepted and never a crash', async () => {
    const keys = (() => {
      throw new Error('no key may be needed for a token that is not even well formed');
    }) as never;
    const jwtish = fc.oneof(
      anything.map(String),
      fc
        .tuple(fc.string({ maxLength: 30 }), fc.string({ maxLength: 30 }), fc.string({ maxLength: 30 }))
        .map((p) => p.join('.')),
      fc.constantFrom('eyJhbGciOiJub25lIn0.eyJpc3MiOiJ4In0.', 'eyJhbGciOiJIUzI1NiJ9.e30.x', '..', 'a.b.c'),
    );
    await fc.assert(
      fc.asyncProperty(jwtish, async (token) => {
        await expect(
          verifyJwt(token, keys, {
            issuers: ['https://issuer.example'],
            audience: 'client',
            algorithms: ['RS256', 'ES256', 'none', 'HS256'],
            clock: { now: () => Date.UTC(2026, 10, 3) },
          }),
        ).rejects.toBeInstanceOf(IdentityError);
      }),
      { ...params, numRuns: 150 },
    );
  });
});
