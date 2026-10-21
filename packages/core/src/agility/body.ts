// SPDX-License-Identifier: Apache-2.0
import { AbError, ErrorCode } from '../errors.ts';

function tooLarge(maxBytes: number): AbError {
  return new AbError(
    ErrorCode.LimitResponseTooLarge,
    `The Agility response is larger than ${Math.round(maxBytes / 1024)} KiB.`,
    {
      hint: 'Ask for fewer rows or fewer fields, or narrow the filters.',
      details: { maxResponseBytes: maxBytes },
      localDetails: true,
    },
  );
}

/** Reads a response body as text, cancelling the stream as soon as it passes `maxBytes` (L-049). */
export async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; bytes: number }> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge(maxBytes);
  }
  if (res.body === null) return { text: '', bytes: 0 };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder().decode(all), bytes };
}
