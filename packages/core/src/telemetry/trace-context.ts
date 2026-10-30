// SPDX-License-Identifier: Apache-2.0
// W3C Trace Context `traceparent`, parsed strictly (P8-07, THREAT_MODEL T30). The header is caller input: a malformed
// one is ignored (a new trace starts), never repaired, and `tracestate` and `baggage` are not read at all. Nothing here
// builds a header for any outgoing request: trace headers are never sent to Agility and never returned to a caller.

export interface TraceParent {
  /** 32 lower-case hex characters, not all zero. */
  readonly traceId: string;
  /** 16 lower-case hex characters, not all zero: the caller's span, our span's parent. */
  readonly parentSpanId: string;
  /** The caller's trace flags (two hex digits); kept for the record, we decide sampling ourselves. */
  readonly flags: string;
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const HEX2 = /^[0-9a-f]{2}$/;
const ZERO32 = '0'.repeat(32);
const ZERO16 = '0'.repeat(16);
/** A traceparent of version 00 is exactly 55 characters. */
const MAX_LENGTH = 55;

/**
 * Parses a `traceparent` value: `00-<32 hex>-<16 hex>-<2 hex>`, lower-case hex, ids not all zero, nothing after the flags.
 * Other versions are refused (a future version may mean something else; we start a new trace instead of guessing), and so is
 * version `ff`. Returns undefined for anything else.
 */
export function parseTraceparent(value: string | null | undefined): TraceParent | undefined {
  if (typeof value !== 'string' || value.length !== MAX_LENGTH) return undefined;
  const parts = value.split('-');
  if (parts.length !== 4) return undefined;
  const [version, traceId, parentSpanId, flags] = parts as [string, string, string, string];
  if (version !== '00') return undefined;
  if (!HEX32.test(traceId) || traceId === ZERO32) return undefined;
  if (!HEX16.test(parentSpanId) || parentSpanId === ZERO16) return undefined;
  if (!HEX2.test(flags)) return undefined;
  return { traceId, parentSpanId, flags };
}

/** Lower-case hex of `bytes`. */
export function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
