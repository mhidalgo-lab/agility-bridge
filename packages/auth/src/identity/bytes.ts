// SPDX-License-Identifier: Apache-2.0
// Small byte helpers for the identity code (web-standard only, ADR-0004).

export const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 as lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(text))));
}
