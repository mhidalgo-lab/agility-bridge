// SPDX-License-Identifier: Apache-2.0
// Input rules and expiry semantics of the kv store, shared by every adapter.
import { InvalidInputError } from './errors.ts';
import type { KvIncrementOptions, KvSetOptions } from './types.ts';

/** Printable ASCII without spaces, so prefix lengths agree between JavaScript and SQLite. */
const KEY = /^[\x21-\x7e]{1,512}$/;
const MAX_VALUE_CHARS = 262_144;

export function checkKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !KEY.test(key)) {
    throw new InvalidInputError('kv keys are 1-512 printable ASCII characters without spaces.');
  }
}

export function checkPrefix(prefix: unknown): asserts prefix is string {
  if (typeof prefix !== 'string' || (prefix !== '' && !KEY.test(prefix))) {
    throw new InvalidInputError('kv prefixes are printable ASCII characters without spaces.');
  }
}

function checkExpiry(expiresAt: unknown): number | null {
  if (expiresAt === undefined || expiresAt === null) return null;
  if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) < 0) {
    throw new InvalidInputError('expiresAt must be epoch milliseconds.');
  }
  return expiresAt as number;
}

/** Validates a value and returns the expiry to store. */
export function checkKvValue(key: unknown, value: unknown, options: KvSetOptions): number | null {
  checkKey(key);
  if (typeof value !== 'string') throw new InvalidInputError('kv values are strings.');
  if (value.length > MAX_VALUE_CHARS)
    throw new InvalidInputError(`kv values are at most ${MAX_VALUE_CHARS} characters.`);
  return checkExpiry(options.expiresAt);
}

export function checkIncrement(
  key: unknown,
  options: KvIncrementOptions,
): { by: number; max: number; expiresAt: number | null } {
  checkKey(key);
  const by = options.by ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(by) || by < 1) throw new InvalidInputError('by must be a positive integer.');
  if (!Number.isSafeInteger(max) || max < 0) throw new InvalidInputError('max must be an integer ≥ 0.');
  return { by, max, expiresAt: checkExpiry(options.expiresAt) };
}

export function isLive(expiresAt: number | null, now: number): boolean {
  return expiresAt === null || expiresAt > now;
}
