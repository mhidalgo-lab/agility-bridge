// SPDX-License-Identifier: Apache-2.0
// HMAC-sealed request state for the 2026-07-28 multi round-trip approval (ADR-0013): the state a client echoes back is
// attacker-controlled, so it is integrity-protected and bound to the change, the actor and an expiry.

export interface ApprovalState {
  /** Nonce of the ledger round entry (single use). */
  readonly n: string;
  /** Hash of the canonical mutation the person was asked about. */
  readonly h: string;
  /** Actor id the question was asked for. */
  readonly a: string;
  /** Expiry, epoch ms. */
  readonly e: number;
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const hmacKey = (key: Uint8Array, usage: 'sign' | 'verify'): ReturnType<typeof crypto.subtle.importKey> =>
  crypto.subtle.importKey('raw', key as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, [
    usage,
  ]);

/** Seals the state: `<payload>.<mac>`, both base64url. The key must be at least 32 bytes. */
export async function sealState(key: Uint8Array, state: ApprovalState): Promise<string> {
  if (key.length < 32) throw new Error('The approval state key must be at least 32 bytes.');
  const payload = b64url(enc.encode(JSON.stringify(state)));
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(key, 'sign'), enc.encode(payload));
  return `${payload}.${b64url(new Uint8Array(mac))}`;
}

/** The state when the seal verifies (constant-time) and the payload is well-formed; `null` otherwise. */
export async function openState(key: Uint8Array, sealed: string): Promise<ApprovalState | null> {
  if (key.length < 32 || sealed.length > 2_048) return null;
  const parts = sealed.split('.');
  if (parts.length !== 2) return null;
  const [payload, mac] = parts as [string, string];
  const macBytes = unb64url(mac);
  if (macBytes === null) return null;
  const ok = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(key, 'verify'),
    macBytes as Uint8Array<ArrayBuffer>,
    enc.encode(payload),
  );
  if (!ok) return null;
  const raw = unb64url(payload);
  if (raw === null) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    return typeof s['n'] === 'string' &&
      typeof s['h'] === 'string' &&
      typeof s['a'] === 'string' &&
      typeof s['e'] === 'number'
      ? { n: s['n'], h: s['h'], a: s['a'], e: s['e'] }
      : null;
  } catch {
    return null;
  }
}
