// SPDX-License-Identifier: Apache-2.0
// Envelope encryption (ADR-0007, L-075): a master key per version, HKDF-SHA-256 purpose keys, AES-256-GCM with a fresh
// 96-bit IV and additional data bound to the record and the key version, HMAC-SHA-256 for key-check values and
// keyed hashes. WebCrypto only, so the same code runs on Node and Workers. Key material never leaves this module: keys
// are imported non-extractable and nothing here logs or returns them.

/** Fixed purpose labels; a key derived for one purpose is useless for another. */
export const KeyPurpose = {
  /** Agility access tokens of credentials. */
  Credentials: 'credentials',
  /** Key-check values that detect a wrong master key. */
  KeyCheck: 'key-check',
  /** Keyed hashes of identities in the audit log (pass-through token fingerprints). */
  AuditIdentity: 'audit-identity',
  /** Sign-in transactions (P4-01): the PKCE verifier and nonce are derived from `state`, never stored. */
  Login: 'login',
  /** Cache entry ids (P8-01). */
  CacheId: 'cache-id',
  /** Bodies of the shared query cache tier (P8-01). */
  CacheBody: 'cache-body',
  /** Write approval records (P7-01). */
  Approval: 'approval',
  /** Task records (P8-10). */
  Task: 'task',
} as const;
export type KeyPurpose = (typeof KeyPurpose)[keyof typeof KeyPurpose];

const ENCRYPTION: ReadonlySet<KeyPurpose> = new Set([
  KeyPurpose.Credentials,
  KeyPurpose.Approval,
  KeyPurpose.Task,
  KeyPurpose.CacheBody,
]);

export type SecretsErrorCode =
  | 'invalid_key'
  | 'wrong_key'
  | 'key_unavailable'
  | 'decrypt_failed'
  | 'retired'
  | 'in_use';

/** A failure of the secrets layer. Messages never contain key material, ciphertext or plaintext. */
export class SecretsError extends Error {
  readonly code: SecretsErrorCode;

  constructor(code: SecretsErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SecretsError';
    this.code = code;
  }
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const MASTER_KEY = /^(?:v([1-9][0-9]{0,2}):)?([A-Za-z0-9+/]{43}=)$/;
const HKDF_SALT = new TextEncoder().encode('agility-bridge/hkdf/v1');

/** The runtime's own base64 (`Uint8Array.prototype.toBase64`, in workerd and newer V8): about 100 times faster there. */
type NativeBase64 = { toBase64?: () => string };
type NativeBase64Static = { fromBase64?: (text: string) => Uint8Array };

export function toBase64(bytes: Uint8Array): string {
  const native = (bytes as NativeBase64).toBase64;
  if (typeof native === 'function') return native.call(bytes);
  // In slices: a per-byte string concatenation cost milliseconds on a 256 KB cache entry (P-1).
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x2000) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x2000)));
  }
  return btoa(parts.join(''));
}

export function fromBase64(text: string): Uint8Array {
  const native = (Uint8Array as unknown as NativeBase64Static).fromBase64;
  // The native decoder is strict (it throws a SyntaxError on a bad character), like `atob`'s InvalidCharacterError.
  if (typeof native === 'function') return native.call(Uint8Array, text);
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text))
    throw new SecretsError('decrypt_failed', 'The sealed value is malformed.');
  const b64 = text.replaceAll('-', '+').replaceAll('_', '/');
  return fromBase64(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

export interface MasterKeyMaterial {
  readonly version: number;
  readonly bytes: Uint8Array;
}

/**
 * Parses `v<N>:<base64 of 32 bytes>` (bare base64 is version 1). The error never echoes the input, which is a secret
 * even when malformed.
 */
export function parseMasterKey(text: string): MasterKeyMaterial {
  const m = MASTER_KEY.exec(typeof text === 'string' ? text.trim() : '');
  if (m === null) {
    throw new SecretsError(
      'invalid_key',
      'The master key must be v<N>:<base64 of 32 random bytes> (generate one with `agility-bridge init`).',
    );
  }
  const bytes = fromBase64(m[2] as string);
  if (bytes.length !== KEY_BYTES) throw new SecretsError('invalid_key', 'The master key must be 32 bytes.');
  if (bytes.every((b) => b === bytes[0])) {
    throw new SecretsError(
      'invalid_key',
      'The master key is not random; generate one with `agility-bridge init`.',
    );
  }
  return Object.freeze({ version: m[1] === undefined ? 1 : Number(m[1]), bytes });
}

/** A new master key, `v<version>:<base64>`, from the platform CSPRNG. */
export function generateMasterKey(version = 1): string {
  if (!Number.isInteger(version) || version < 1 || version > 999) {
    throw new SecretsError('invalid_key', 'Key versions are 1-999.');
  }
  return `v${version}:${toBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)))}`;
}

/** An encrypted value and the key version that sealed it. */
export interface Sealed {
  readonly ciphertext: string;
  readonly iv: string;
  readonly keyVersion: number;
}

/** WebCrypto's key type, spelled so that both the web and the Node type libraries accept it. */
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const additionalData = (context: string, version: number): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(`${context}|${version}`);

/**
 * The current master key and, during a rotation, the previous one. Purpose keys are derived once per version and kept
 * as non-extractable `CryptoKey`s (per process, never request data).
 */
export class Keyring {
  readonly currentVersion: number;
  readonly versions: readonly number[];
  readonly #roots: ReadonlyMap<number, Key>;
  readonly #derived = new Map<string, Promise<Key>>();

  private constructor(currentVersion: number, roots: Map<number, Key>) {
    this.currentVersion = currentVersion;
    this.#roots = roots;
    this.versions = Object.freeze([...roots.keys()].sort((a, b) => a - b));
  }

  /** Builds a keyring from the current master key and, during a rotation, the previous one (a lower version). */
  static async create(current: string, previous?: string): Promise<Keyring> {
    const cur = parseMasterKey(current);
    const roots = new Map<number, Key>();
    const importRoot = (bytes: Uint8Array) =>
      crypto.subtle.importKey('raw', bytes as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveKey']);
    roots.set(cur.version, await importRoot(cur.bytes));
    if (previous !== undefined) {
      const prev = parseMasterKey(previous);
      if (prev.version >= cur.version) {
        throw new SecretsError(
          'invalid_key',
          `The previous master key (version ${prev.version}) must have a lower version than the current one (version ${cur.version}).`,
        );
      }
      if (prev.bytes.every((b, i) => b === cur.bytes[i])) {
        throw new SecretsError('invalid_key', 'The previous and current master keys are the same key.');
      }
      roots.set(prev.version, await importRoot(prev.bytes));
    }
    return new Keyring(cur.version, roots);
  }

  has(version: number): boolean {
    return this.#roots.has(version);
  }

  /**
   * Derives every purpose key of every loaded version now. Workers boot with it (L-096): the keyring is shared by the
   * requests of an isolate, and a derivation started by one request must not be awaited by another.
   */
  async warm(purposes: readonly KeyPurpose[] = Object.values(KeyPurpose)): Promise<void> {
    await Promise.all(this.versions.flatMap((v) => purposes.map((purpose) => this.#key(purpose, v))));
  }

  #key(purpose: KeyPurpose, version: number): Promise<Key> {
    const root = this.#roots.get(version);
    if (root === undefined) {
      return Promise.reject(
        new SecretsError(
          'key_unavailable',
          `Master key version ${version} is not loaded (AB_MASTER_KEY_PREVIOUS?).`,
        ),
      );
    }
    const id = `${version}/${purpose}`;
    let key = this.#derived.get(id);
    if (key === undefined) {
      const info = new TextEncoder().encode(`agility-bridge/${purpose}/v${version}`);
      const algorithm = { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info };
      key = ENCRYPTION.has(purpose)
        ? crypto.subtle.deriveKey(algorithm, root, { name: 'AES-GCM', length: 256 }, false, [
            'encrypt',
            'decrypt',
          ])
        : crypto.subtle.deriveKey(algorithm, root, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, [
            'sign',
          ]);
      this.#derived.set(id, key);
    }
    return key;
  }

  /** Encrypts with the current key; `context` (a record id) and the version are bound as additional data. */
  async seal(purpose: KeyPurpose, context: string, plaintext: string): Promise<Sealed> {
    if (!ENCRYPTION.has(purpose)) throw new TypeError(`${purpose} is not an encryption purpose.`);
    const version = this.currentVersion;
    const key = await this.#key(purpose, version);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData(context, version), tagLength: 128 },
      key,
      new TextEncoder().encode(plaintext),
    );
    return Object.freeze({
      ciphertext: toBase64Url(new Uint8Array(data)),
      iv: toBase64Url(iv),
      keyVersion: version,
    });
  }

  /** Decrypts a sealed value; a wrong key, context or version, or any tampering, fails with `decrypt_failed`. */
  async open(purpose: KeyPurpose, context: string, sealed: Sealed): Promise<string> {
    if (!ENCRYPTION.has(purpose)) throw new TypeError(`${purpose} is not an encryption purpose.`);
    const key = await this.#key(purpose, sealed.keyVersion);
    const iv = fromBase64Url(sealed.iv);
    if (iv.length !== IV_BYTES) throw new SecretsError('decrypt_failed', 'The sealed value is malformed.');
    try {
      const data = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: iv as Uint8Array<ArrayBuffer>,
          additionalData: additionalData(context, sealed.keyVersion),
          tagLength: 128,
        },
        key,
        fromBase64Url(sealed.ciphertext) as Uint8Array<ArrayBuffer>,
      );
      return new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch (error) {
      throw new SecretsError(
        'decrypt_failed',
        'The sealed value could not be decrypted with this master key.',
        {
          cause: error,
        },
      );
    }
  }

  /** HMAC-SHA-256 (hex) with the purpose key of `version` (default current). */
  async mac(purpose: KeyPurpose, data: string, version: number = this.currentVersion): Promise<string> {
    if (ENCRYPTION.has(purpose)) throw new TypeError(`${purpose} is an encryption purpose.`);
    const key = await this.#key(purpose, version);
    return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  }

  /** The key-check value of a version: proves the key without revealing it. */
  keyCheckValue(version: number): Promise<string> {
    return this.mac(KeyPurpose.KeyCheck, 'agility-bridge key check', version);
  }
}

/** Constant-time comparison of two strings of equal length (false otherwise). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
