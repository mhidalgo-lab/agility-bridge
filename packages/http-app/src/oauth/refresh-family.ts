// SPDX-License-Identifier: Apache-2.0
// The refresh family's storage format (P5-05, D-63, D-70). Web-standard only (no node:*, no Buffer).
//
// `workers-oauth-provider` keeps one refresh token per grant (plus the previous one, unlimited in time). The token
// endpoint wraps it: when a refresh token is spent, a **rotation marker** (hash only) outlives the refresh lifetime so a
// late replay is recognised, and the provider's answer is kept **sealed** for the reuse window so a repeat inside it can
// be answered with the same successor. The seal's key is derived from the spent refresh token itself: the successor is
// readable by whoever holds the token that is allowed to ask for it, and by nobody who only has the database (L-074: no
// key stored beside the data, and none to rotate or back up).

/** Rotation markers, `oauth-rotated:<sha256(spent refresh token)>`: `{"at": <epoch ms>}`, kept for the refresh lifetime. */
export const ROTATED_PREFIX = 'oauth-rotated:';
/** Sealed successors, `oauth-successor:<sha256(spent refresh token)>`: kept for the reuse window only. */
export const SUCCESSOR_PREFIX = 'oauth-successor:';
/** One request at a time spends a refresh token, `oauth-refresh-claim:<sha256(refresh token)>`. */
export const CLAIM_PREFIX = 'oauth-refresh-claim:';

const SALT = new TextEncoder().encode('agility-bridge/oauth-refresh-successor/v1');
const IV_BYTES = 12;

/** What a repeat inside the window is answered with: the provider's token response, plus the client it was issued to. */
export interface SealedSuccessor {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch ms at which the access token expires. */
  readonly accessExpiresAt: number;
  readonly scope: string;
  readonly resource: string | null;
  readonly clientId: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

async function sealKey(
  spentRefreshToken: string,
  tokenHash: string,
): Promise<Awaited<ReturnType<typeof crypto.subtle.deriveKey>>> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(spentRefreshToken),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: new TextEncoder().encode(tokenHash) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** AES-256-GCM under a key derived from the spent token; the row is bound to the token's hash (AAD). */
export async function sealSuccessor(
  spentRefreshToken: string,
  tokenHash: string,
  successor: SealedSuccessor,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(tokenHash) },
      await sealKey(spentRefreshToken, tokenHash),
      new TextEncoder().encode(JSON.stringify(successor)),
    ),
  );
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv);
  out.set(cipher, iv.length);
  return toBase64Url(out);
}

/** The successor, or `null` when the row is not a seal of this token (wrong token, tampered, corrupt). */
export async function openSuccessor(
  spentRefreshToken: string,
  tokenHash: string,
  sealed: string,
): Promise<SealedSuccessor | null> {
  try {
    const bytes = fromBase64Url(sealed);
    if (bytes.length <= IV_BYTES) return null;
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes.slice(0, IV_BYTES),
        additionalData: new TextEncoder().encode(tokenHash),
      },
      await sealKey(spentRefreshToken, tokenHash),
      bytes.slice(IV_BYTES),
    );
    const v = JSON.parse(new TextDecoder().decode(plain)) as Partial<SealedSuccessor> | null;
    if (
      v === null ||
      typeof v !== 'object' ||
      typeof v.accessToken !== 'string' ||
      typeof v.refreshToken !== 'string' ||
      typeof v.accessExpiresAt !== 'number' ||
      typeof v.scope !== 'string' ||
      typeof v.clientId !== 'string' ||
      (v.resource !== null && typeof v.resource !== 'string')
    ) {
      return null;
    }
    return v as SealedSuccessor;
  } catch {
    return null;
  }
}

/** The client a token request authenticates as, the way the provider reads it: a Basic header, else `client_id`. */
export function requestClientId(authorization: string | null, form: URLSearchParams): string | null {
  if (form.has('client_assertion') || form.has('client_assertion_type')) return null;
  if (authorization !== null && /^basic[ \t]/i.test(authorization)) {
    try {
      const credentials = atob(authorization.slice('basic'.length).trim());
      const colon = credentials.indexOf(':');
      if (colon < 1) return null;
      const id = decodeURIComponent(credentials.slice(0, colon).replaceAll('+', ' '));
      return id === '' ? null : id;
    } catch {
      return null;
    }
  }
  const id = form.get('client_id');
  return id === null || id === '' ? null : id;
}
