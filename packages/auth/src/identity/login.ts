// SPDX-License-Identifier: Apache-2.0
// Login transactions and setup links (P4-01). Both live in the storage's `kv` table (D1 on Workers, SQLite on Node),
// never in isolate memory, so any isolate or process can finish a login another one started. Both are single use:
// they are consumed with the atomic `kv.take`, so a replayed `state` or setup link finds nothing.
//
// A transaction is keyed by SHA-256(state) and holds the provider, the setup link hash (if any), the post-login path
// and SHA-256 of a random **binding** value that only the browser that started the login has (an HttpOnly cookie). The
// callback must present that cookie, so an attacker can't make a victim's browser finish a login the attacker started
// (login CSRF), or finish the victim's login in another browser.
//
// The PKCE verifier and the nonce are *derived* from `state` with the master key's `login` purpose key (HMAC-SHA-256)
// instead of being stored: nothing recoverable sits in the database (ADR-0009: transient secrets are not stored in
// the clear), and `state` alone, which travels through the browser and the IdP, reveals neither.
import type { Clock } from '@agility-bridge/core';
import type { KvStore } from '@agility-bridge/storage';
import { KeyPurpose, type Keyring, timingSafeEqual } from '../secrets/keyring.ts';
import { base64url, sha256Hex, toHex, utf8 } from './bytes.ts';
import { IdentityError } from './errors.ts';

type Kv = Pick<KvStore, 'get' | 'set' | 'take'>;
type ClockLike = Pick<Clock, 'now'>;
/** What the transactions need of the keyring: the keyed hash of the `login` purpose, by key version. */
export type LoginKeys = Pick<Keyring, 'mac' | 'currentVersion'>;

/** How long a started login may take at the IdP. */
export const LOGIN_TTL_SECONDS = 600;
/** Setup links: default and largest lifetime. */
export const DEFAULT_SETUP_LINK_TTL_MS: number = 60 * 60_000;
export const MIN_SETUP_LINK_TTL_MS = 60_000;
export const MAX_SETUP_LINK_TTL_MS: number = 7 * 24 * 60 * 60_000;
export const SETUP_CODE_RE: RegExp = /^ab_setup_[0-9a-f]{64}$/;
/** 32 random bytes, base64url (43 characters): `state` and the binding value. */
const RANDOM_RE = /^[A-Za-z0-9_-]{43}$/;

const LOGIN_PREFIX = 'login:';
const SETUP_PREFIX = 'setup:';

export function randomValue(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** RFC 7636 S256: BASE64URL(SHA-256(ASCII(verifier))). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(verifier))));
}

/** The PKCE verifier and nonce of the login with this `state`: 64 hex characters each (RFC 7636 allows 43-128). */
export async function deriveLoginSecrets(
  keys: LoginKeys,
  state: string,
  keyVersion: number,
): Promise<{ readonly codeVerifier: string; readonly nonce: string }> {
  const [codeVerifier, nonce] = await Promise.all([
    keys.mac(KeyPurpose.Login, `pkce|${state}`, keyVersion),
    keys.mac(KeyPurpose.Login, `nonce|${state}`, keyVersion),
  ]);
  return { codeVerifier, nonce };
}

export interface LoginTransaction {
  readonly provider: string;
  /** SHA-256 hex of the binding cookie value. */
  readonly binding: string;
  /** SHA-256 hex of the setup code, when the login started from a setup link. */
  readonly setup: string | null;
  /** Validated same-origin path to continue to. */
  readonly next: string;
  /** Re-authentication (P4-02): the id of the signed-in user this login must resolve to; null for a plain sign-in. */
  readonly reauth: string | null;
  /** Master-key version that derived the verifier and nonce. */
  readonly keyVersion: number;
  readonly createdAt: number;
}

/** A transaction the callback accepted, with the secrets re-derived for the token exchange. */
export interface FinishedLogin extends LoginTransaction {
  readonly codeVerifier: string;
  readonly nonce: string;
}

export interface StartedLogin {
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  /** Goes into the HttpOnly binding cookie; only its hash is stored. */
  readonly binding: string;
}

export async function startLogin(
  kv: Kv,
  keys: LoginKeys,
  input: {
    readonly provider: string;
    readonly next: string;
    readonly setup: string | null;
    readonly reauth?: string | null;
  },
  clock: ClockLike,
): Promise<StartedLogin> {
  const state = randomValue();
  const binding = randomValue();
  const keyVersion = keys.currentVersion;
  const { codeVerifier, nonce } = await deriveLoginSecrets(keys, state, keyVersion);
  const tx: LoginTransaction = {
    provider: input.provider,
    binding: await sha256Hex(binding),
    setup: input.setup,
    next: input.next,
    reauth: input.reauth ?? null,
    keyVersion,
    createdAt: clock.now(),
  };
  await kv.set(`${LOGIN_PREFIX}${await sha256Hex(state)}`, JSON.stringify(tx), {
    expiresAt: clock.now() + LOGIN_TTL_SECONDS * 1000,
  });
  return { state, nonce, codeChallenge: await pkceChallenge(codeVerifier), binding };
}

function parseTransaction(raw: string): LoginTransaction | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const s = (k: string) => typeof v[k] === 'string';
    if (!s('provider') || !s('binding') || !s('next')) return null;
    if (v['setup'] !== null && !s('setup')) return null;
    if (v['reauth'] !== undefined && v['reauth'] !== null && !s('reauth')) return null;
    if (typeof v['createdAt'] !== 'number' || !Number.isSafeInteger(v['keyVersion'])) return null;
    return v as unknown as LoginTransaction;
  } catch {
    return null;
  }
}

/**
 * Consume the transaction of `state` (at most once) and check that it belongs to this browser and provider. Throws
 * `IdentityError` (`invalid_callback`, `unknown_state`, `binding_mismatch`, `provider_mismatch`).
 */
export async function finishLogin(
  kv: Kv,
  keys: LoginKeys,
  input: {
    readonly state: string | undefined;
    readonly binding: string | undefined;
    readonly provider: string;
  },
  clock: ClockLike,
): Promise<FinishedLogin> {
  if (input.state === undefined || !RANDOM_RE.test(input.state)) {
    throw new IdentityError('invalid_callback', 'missing or malformed state');
  }
  // Consumed first: whatever else is wrong with this callback, the transaction is gone.
  const raw = await kv.take(`${LOGIN_PREFIX}${await sha256Hex(input.state)}`);
  const tx = raw === null ? null : parseTransaction(raw);
  if (tx === null || clock.now() - tx.createdAt > LOGIN_TTL_SECONDS * 1000) {
    throw new IdentityError('unknown_state', 'unknown, used or expired login');
  }
  const presented = input.binding !== undefined && RANDOM_RE.test(input.binding) ? input.binding : '';
  if (!timingSafeEqual(await sha256Hex(presented), tx.binding)) {
    throw new IdentityError('binding_mismatch', 'the login was started in another browser');
  }
  if (tx.provider !== input.provider) {
    throw new IdentityError('provider_mismatch', 'the login was started with another provider');
  }
  let secrets: { codeVerifier: string; nonce: string };
  try {
    secrets = await deriveLoginSecrets(keys, input.state, tx.keyVersion);
  } catch {
    // The master key version that started this login is gone (retired mid-flight): start again.
    throw new IdentityError('unknown_state', 'unknown, used or expired login');
  }
  return { ...tx, reauth: tx.reauth ?? null, ...secrets };
}

// ---------------------------------------------------------------------------------------------------------------
// Setup links (first-owner bootstrap)
// ---------------------------------------------------------------------------------------------------------------

export interface SetupLink {
  /** Shown once (in the admin API answer); only its hash is stored. */
  readonly code: string;
  readonly expiresAt: number;
}

export async function createSetupLink(kv: Kv, ttlMs: number, clock: ClockLike): Promise<SetupLink> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_SETUP_LINK_TTL_MS || ttlMs > MAX_SETUP_LINK_TTL_MS) {
    throw new RangeError('setup link lifetime must be between 1 minute and 7 days');
  }
  const code = `ab_setup_${toHex(crypto.getRandomValues(new Uint8Array(32)))}`;
  const expiresAt = clock.now() + ttlMs;
  await kv.set(`${SETUP_PREFIX}${await sha256Hex(code)}`, JSON.stringify({ expiresAt }), { expiresAt });
  return { code, expiresAt };
}

/** The storage key hash of a setup code, or null when it is not one (checked before any storage read). */
export async function setupCodeHash(code: string | undefined): Promise<string | null> {
  if (code === undefined || !SETUP_CODE_RE.test(code)) return null;
  return sha256Hex(code);
}

function liveSetup(raw: string | null, clock: ClockLike): boolean {
  if (raw === null) return false;
  try {
    const v = JSON.parse(raw) as { expiresAt?: unknown };
    return typeof v.expiresAt === 'number' && clock.now() < v.expiresAt;
  } catch {
    return false;
  }
}

/** Whether a setup link is still usable (does not consume it). */
export async function setupLinkUsable(kv: Kv, hash: string, clock: ClockLike): Promise<boolean> {
  return liveSetup(await kv.get(`${SETUP_PREFIX}${hash}`), clock);
}

/** Consume a setup link: true for exactly one caller while it is live. */
export async function consumeSetupLink(kv: Kv, hash: string, clock: ClockLike): Promise<boolean> {
  return liveSetup(await kv.take(`${SETUP_PREFIX}${hash}`), clock);
}
