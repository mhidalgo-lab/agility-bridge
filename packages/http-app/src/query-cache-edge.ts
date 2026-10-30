// SPDX-License-Identifier: Apache-2.0
// The shared tier of the query cache on Workers (P8-01, L-098, THREAT_MODEL T16): the Cache API, local to one data centre
// and sometimes a silent no-op (`workers.dev`, some access products). Bodies are Agility data, so they are sealed with the
// keyring's `cache-body` purpose and bound to their entry id before they leave the isolate; the entry id is itself a
// keyed hash (core `QueryCache.key`). The tier reports `verified` only after reading a first write back and finding it
// intact, and `unavailable` when it did not: a no-op cache is then never counted on, and rechecked after a pause.
import { KeyPurpose, type Keyring, type Sealed } from '@agility-bridge/auth';
import type { Clock, SharedTier, SharedTierStatus } from '@agility-bridge/core';

/** The slice of the Workers `Cache` the tier uses. */
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface EdgeTierOptions {
  readonly cache: CacheLike;
  readonly keyring: Keyring;
  readonly clock: Clock;
  /** A fixed, non-routable origin under which entries are stored. */
  readonly origin?: string;
  /** How long an `unavailable` tier waits before it is tried again. */
  readonly retryAfterMs?: number;
}

const DEFAULT_ORIGIN = 'https://query-cache.agility-bridge.invalid';

function isSealed(v: unknown): v is Sealed {
  if (v === null || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s['ciphertext'] === 'string' && typeof s['iv'] === 'string' && typeof s['keyVersion'] === 'number'
  );
}

export class EdgeQueryTier implements SharedTier {
  readonly #opts: EdgeTierOptions;
  readonly #origin: string;
  readonly #retryAfterMs: number;
  #status: SharedTierStatus = 'unverified';
  #retryAt = 0;

  constructor(options: EdgeTierOptions) {
    this.#opts = options;
    this.#origin = options.origin ?? DEFAULT_ORIGIN;
    this.#retryAfterMs = options.retryAfterMs ?? 10 * 60_000;
  }

  status(): SharedTierStatus {
    return this.#status;
  }

  #request(id: string): Request {
    return new Request(`${this.#origin}/q/${id}`);
  }

  /** Whether the tier may be used now: an unavailable tier is retried after a pause. */
  #usable(): boolean {
    return this.#status !== 'unavailable' || this.#opts.clock.now() >= this.#retryAt;
  }

  async #read(id: string): Promise<string | undefined> {
    const res = await this.#opts.cache.match(this.#request(id));
    if (res === undefined) return undefined;
    const sealed: unknown = await res.json();
    if (!isSealed(sealed)) return undefined;
    // A wrong key, entry id or tampering fails here and counts as a miss.
    return this.#opts.keyring.open(KeyPurpose.CacheBody, id, sealed);
  }

  async get(id: string): Promise<string | undefined> {
    if (!this.#usable()) return undefined;
    try {
      return await this.#read(id);
    } catch {
      return undefined;
    }
  }

  async set(id: string, text: string, ttlMs: number): Promise<void> {
    if (!this.#usable()) return;
    const sealed = await this.#opts.keyring.seal(KeyPurpose.CacheBody, id, text);
    const response = new Response(JSON.stringify(sealed), {
      headers: {
        'content-type': 'application/json',
        'cache-control': `public, max-age=${Math.max(1, Math.floor(ttlMs / 1000))}`,
      },
    });
    try {
      await this.#opts.cache.put(this.#request(id), response);
    } catch {
      this.#fail();
      return;
    }
    // Read the first write back (and every write while unproven): a cache that stores nothing must not be reported as one.
    if (this.#status === 'verified') return;
    let back: string | undefined;
    try {
      back = await this.#read(id);
    } catch {
      back = undefined;
    }
    if (back === text) this.#status = 'verified';
    else this.#fail();
  }

  #fail(): void {
    this.#status = 'unavailable';
    this.#retryAt = this.#opts.clock.now() + this.#retryAfterMs;
  }
}
