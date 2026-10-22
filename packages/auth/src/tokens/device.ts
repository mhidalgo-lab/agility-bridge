// SPDX-License-Identifier: Apache-2.0
// Device access tokens (ARCHITECTURE §4, L-066, L-067, THREAT_MODEL T1, T2): `ab_live_<43 base62>_<6 base62>`, 256
// random bits and a CRC-32 checksum so secret scanners recognise them (the checksum is not a security control). Only the
// SHA-256 is stored; the token is shown once. The checksum is verified before any storage read.
import type { AccessToken, Storage } from '@agility-bridge/storage';
import { type AccessDecision, type AccessSettings, resolveAccess } from '../access/resolve.ts';
import { timingSafeEqual } from '../secrets/keyring.ts';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BODY_CHARS = 43;
const CHECKSUM_CHARS = 6;
const FORMAT = /^(ab_(?:live|test))_([0-9A-Za-z]{43})_([0-9A-Za-z]{6})$/;

/** `live` on production deployments, `test` elsewhere, so a test token is recognisable wherever it leaks. */
export type TokenEnvironment = 'live' | 'test';

/** `lastUsedAt` is written at most this often (ARCHITECTURE §4). */
export const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
/** Default lifetime of a new device token. */
export const DEFAULT_TOKEN_DAYS = 90;

function base62(value: bigint, width: number): string {
  let out = '';
  for (let v = value; v > 0n; v /= 62n) out = BASE62[Number(v % 62n)] + out;
  return out.padStart(width, '0');
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3) of a string's UTF-8 bytes. */
export function crc32(text: string): number {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(text))
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const checksum = (prefix: string, body: string) => base62(BigInt(crc32(`${prefix}_${body}`)), CHECKSUM_CHARS);

/** `<prefix>_<43 base62 from 256 random bits>_<6 base62 CRC-32 of the rest>`. */
export function randomTypedToken(prefix: string): { token: string; body: string } {
  let n = 0n;
  for (const b of crypto.getRandomValues(new Uint8Array(32))) n = (n << 8n) | BigInt(b);
  const body = base62(n, BODY_CHARS);
  return { token: `${prefix}_${body}_${checksum(prefix, body)}`, body };
}

/** Whether `text` is `<prefix>_<43 base62>_<6 base62>` with a matching checksum. */
export function isTypedToken(text: unknown, prefix: string): boolean {
  if (typeof text !== 'string' || text.length !== prefix.length + 1 + BODY_CHARS + 1 + CHECKSUM_CHARS)
    return false;
  if (!text.startsWith(`${prefix}_`)) return false;
  const body = text.slice(prefix.length + 1, prefix.length + 1 + BODY_CHARS);
  const sum = text.slice(-CHECKSUM_CHARS);
  if (
    !/^[0-9A-Za-z]+$/.test(body) ||
    !/^[0-9A-Za-z]+$/.test(sum) ||
    text[prefix.length + 1 + BODY_CHARS] !== '_'
  ) {
    return false;
  }
  return timingSafeEqual(sum, checksum(prefix, body));
}

/** SHA-256 (lower-case hex) of a device token: what storage keeps. */
export async function hashDeviceToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface NewDeviceToken {
  /** Show this once; it is never stored or shown again. */
  readonly token: string;
  /** For lists: `ab_live_` and the first 4 characters. */
  readonly displayPrefix: string;
  readonly tokenHash: string;
}

/** A new random device token. */
export async function generateDeviceToken(environment: TokenEnvironment): Promise<NewDeviceToken> {
  const prefix = `ab_${environment}`;
  const { token, body } = randomTypedToken(prefix);
  return { token, displayPrefix: `${prefix}_${body.slice(0, 4)}`, tokenHash: await hashDeviceToken(token) };
}

/** The format and checksum, offline: `false` for anything that cannot be a token we issued. */
export function isWellFormedDeviceToken(text: unknown, environment?: TokenEnvironment): boolean {
  if (typeof text !== 'string' || text.length !== 8 + BODY_CHARS + 1 + CHECKSUM_CHARS) return false;
  const m = FORMAT.exec(text);
  if (m === null) return false;
  const [, prefix, body, sum] = m as unknown as [string, string, string, string];
  if (environment !== undefined && prefix !== `ab_${environment}`) return false;
  return timingSafeEqual(sum, checksum(prefix, body));
}

/** Extracts a bearer token from an `Authorization` header value; `null` when absent or not a bearer credential. */
export function bearerToken(header: string | null | undefined): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer[ ]+(\S{1,512})[ ]*$/i.exec(header);
  return m === null ? null : (m[1] as string);
}

export type AuthenticationDecision =
  | (AccessDecision & { readonly ok: true; readonly token: AccessToken })
  | {
      readonly ok: false;
      readonly reason: 'token_malformed' | 'token_unknown' | Extract<AccessDecision, { ok: false }>['reason'];
    };

/**
 * Authenticates a device token for the workspace `slug` and resolves its access: format and checksum first (no
 * storage read for garbage), then the hash lookup and a constant-time comparison, then everything `resolveAccess`
 * checks (workspace binding first, revocation, expiry, grant, credential, policies). `lastUsedAt` is touched at most
 * every 5 minutes, best effort.
 */
export async function authenticateDeviceToken(
  storage: Storage,
  presented: string,
  slug: string,
  settings: AccessSettings & { readonly environment: TokenEnvironment },
  now: number,
): Promise<AuthenticationDecision> {
  if (!isWellFormedDeviceToken(presented, settings.environment))
    return { ok: false, reason: 'token_malformed' };
  const hash = await hashDeviceToken(presented);
  // The token and every record its access reads, in one round trip (one D1 batch, P3-02).
  const { token, ...records } = await storage.accessTokens.bundleByHash(hash);
  if (token === null || !timingSafeEqual(token.tokenHash, hash))
    return { ok: false, reason: 'token_unknown' };
  const decision = resolveAccess({ kind: 'device_token', token }, slug, records, settings, now);
  if (!decision.ok) return decision;
  try {
    await storage.accessTokens.touch(token.id, TOUCH_INTERVAL_MS);
  } catch {
    // Usage tracking never blocks a request.
  }
  return { ...decision, token };
}
