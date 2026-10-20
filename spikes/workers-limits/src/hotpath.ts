// SPDX-License-Identifier: Apache-2.0
// P0-09: the per-call hot path, web-standard only so the same code runs on Node and workerd.
// Synthetic Agility-shaped payloads, a byte-capped body read, JSON parse + shaping, and the AES-256-GCM + HKDF envelope.

const encoder = new TextEncoder();

/** A synthetic `query.v1` response: an array of result sets, one with `rows` Story-like assets (no real data). */
export function syntheticQueryResult(targetBytes: number): string {
  const rows: unknown[] = [];
  let size = 2;
  for (let i = 0; size < targetBytes; i++) {
    const row = {
      _oid: `Story:${100000 + i}`,
      Number: `B-${String(10000 + i).padStart(5, '0')}`,
      Name: `Synthetic backlog item ${i}: improve the widget export for team ${i % 17}`,
      'Status.Name': ['Future', 'In Progress', 'Done', 'Accepted'][i % 4],
      'Owners.Name': [`Member ${i % 29}`, `Member ${(i + 7) % 29}`],
      Estimate: (i % 13) + 0.5,
      'Timebox.Name': `Sprint ${i % 40}`,
      'Scope.Name': `Project ${i % 9}`,
      Description:
        `<p>As a user I want export ${i} so that <b>reports</b> stay current &amp; shareable.</p>`.repeat(2),
      ChangeDate: new Date(Date.UTC(2026, 9, 1, 0, i % 60)).toISOString(),
    };
    const json = JSON.stringify(row);
    size += json.length + 1;
    rows.push(row);
  }
  return JSON.stringify([rows]);
}

/** A synthetic `rest-1.v1/Data` XML response with the same rows. */
export function syntheticRestXml(targetBytes: number): string {
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?><Assets total="0" pageSize="2147483647" pageStart="0">',
  ];
  let size = parts[0]?.length ?? 0;
  for (let i = 0; size < targetBytes; i++) {
    const a =
      `<Asset href="/inst/rest-1.v1/Data/Story/${100000 + i}" id="Story:${100000 + i}">` +
      `<Attribute name="Number">B-${String(10000 + i).padStart(5, '0')}</Attribute>` +
      `<Attribute name="Name">Synthetic backlog item ${i}: improve the widget export</Attribute>` +
      `<Attribute name="Status.Name">${['Future', 'In Progress', 'Done', 'Accepted'][i % 4]}</Attribute>` +
      `<Attribute name="Estimate">${(i % 13) + 0.5}</Attribute>` +
      `<Attribute name="Description">&lt;p&gt;As a user I want export ${i} so that reports stay current &amp;amp; shareable.&lt;/p&gt;</Attribute>` +
      `<Relation name="Scope"><Asset href="/inst/rest-1.v1/Data/Scope/${i % 9}" idref="Scope:${i % 9}" /></Relation>` +
      '</Asset>';
    parts.push(a);
    size += a.length;
  }
  parts.push('</Assets>');
  return parts.join('');
}

export class ResponseTooLargeError extends Error {}

/** Reads a body stream with a byte cap enforced while streaming, before any parsing (L-049). */
export async function readCapped(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError(`response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(out);
}

/** Parse + shape: the compact row output a tool would return (100-row cap, 120-char cells). */
export function parseAndShape(json: string): { rows: number; text: string } {
  const sets = JSON.parse(json) as Array<Array<Record<string, unknown>>>;
  const rows = sets[0] ?? [];
  const cell = (v: unknown): string => {
    const s = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    return s.length > 120 ? `${s.slice(0, 119)}…` : s;
  };
  const lines = rows
    .slice(0, 100)
    .map((r) =>
      [r['Number'], r['Name'], r['Status.Name'], r['Owners.Name'], r['Estimate']].map(cell).join(' | '),
    );
  return { rows: rows.length, text: lines.join('\n') };
}

// --- Envelope encryption (ADR-0007 prototype): HKDF-SHA-256 derives a per-purpose key from the master key; AES-256-GCM
// with a random 96-bit IV and the record id as additional authenticated data.

export async function deriveKey(masterKeyRaw: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', masterKeyRaw, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('agility-bridge/v1'), info: encoder.encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function seal(key: CryptoKey, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
      key,
      encoder.encode(plaintext),
    ),
  );
  return `v1.${b64(iv)}.${b64(ct)}`;
}

export async function open(key: CryptoKey, sealed: string, aad: string): Promise<string> {
  const [version, iv, ct] = sealed.split('.');
  if (version !== 'v1' || iv === undefined || ct === undefined) throw new Error('bad envelope');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(iv), additionalData: encoder.encode(aad) },
    key,
    unb64(ct),
  );
  return new TextDecoder().decode(pt);
}

/** A fixed, non-secret test master key (32 bytes) shared by the Node and workerd sides of the round trip. */
export const TEST_MASTER_KEY = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
