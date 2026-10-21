// SPDX-License-Identifier: Apache-2.0
// The access cache (ARCHITECTURE §5 step 3, L-068, THREAT_MODEL T15): successful resolutions only, keyed by the token
// hash and the workspace slug (never the token), for at most 60 s and never past the access's own expiry; bounded in
// size; cleared on local admin changes. Other processes honour a revocation within the TTL.
import type { EffectiveAccess } from '@agility-bridge/auth';

export const MAX_ACCESS_CACHE_TTL_MS = 60_000;

interface Entry {
  readonly access: EffectiveAccess;
  readonly until: number;
}

export class AccessCache {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, Entry>();

  constructor(ttlMs: number, maxEntries = 10_000) {
    if (!Number.isInteger(ttlMs) || ttlMs < 0 || ttlMs > MAX_ACCESS_CACHE_TTL_MS) {
      throw new RangeError('The access cache TTL must be 0-60 s.');
    }
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
  }

  get(tokenHash: string, slug: string, now: number): EffectiveAccess | undefined {
    const key = `${tokenHash}|${slug}`;
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.until <= now) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.access;
  }

  set(tokenHash: string, slug: string, access: EffectiveAccess, now: number): void {
    if (this.#ttlMs === 0) return;
    const until = Math.min(now + this.#ttlMs, access.expiresAt ?? Number.POSITIVE_INFINITY);
    if (until <= now) return;
    if (this.#entries.size >= this.#maxEntries) {
      // Oldest first (insertion order); expired entries go too.
      for (const [k, e] of this.#entries) {
        if (this.#entries.size < this.#maxEntries && e.until > now) break;
        this.#entries.delete(k);
      }
    }
    this.#entries.set(`${tokenHash}|${slug}`, { access, until });
  }

  /** Called after any local change to instances, credentials, workspaces, grants, tokens or users. */
  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}
