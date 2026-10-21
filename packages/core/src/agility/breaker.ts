// SPDX-License-Identifier: Apache-2.0
import { type Breaker, type Clock, systemClock } from '../context.ts';

interface State {
  consecutive: number;
  openUntil: number;
}

export interface CircuitBreakerOptions {
  /** Consecutive 429 answers that open the breaker (default 3). */
  readonly threshold?: number;
  /** How long it stays open, at least; a longer Retry-After wins (default 30 s). */
  readonly openMs?: number;
  readonly clock?: Clock;
  readonly maxKeys?: number;
}

/**
 * Circuit breakers keyed by instance **and** credential (ADR-0010): Agility quotas are per consumer, so one member's
 * 429s must not block another. Owned by the host per process; tools only see the `Breaker` in their context.
 */
export class CircuitBreakers {
  readonly #threshold: number;
  readonly #openMs: number;
  readonly #clock: Clock;
  readonly #maxKeys: number;
  readonly #byKey = new Map<string, State>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.#threshold = options.threshold ?? 3;
    this.#openMs = options.openMs ?? 30_000;
    this.#clock = options.clock ?? systemClock;
    this.#maxKeys = options.maxKeys ?? 10_000;
  }

  for(instanceId: string, credentialId: string): Breaker {
    const key = `${instanceId}\u0000${credentialId}`;
    const state = (): State => {
      let s = this.#byKey.get(key);
      if (s === undefined) {
        if (this.#byKey.size >= this.#maxKeys) this.#prune();
        s = { consecutive: 0, openUntil: 0 };
        this.#byKey.set(key, s);
      }
      return s;
    };
    return {
      openForMs: () => Math.max(0, (this.#byKey.get(key)?.openUntil ?? 0) - this.#clock.now()),
      onRateLimited: (retryAfterMs) => {
        const s = state();
        s.consecutive++;
        if (s.consecutive >= this.#threshold) {
          s.openUntil = this.#clock.now() + Math.max(this.#openMs, retryAfterMs ?? 0);
          s.consecutive = 0;
        }
      },
      onSuccess: () => {
        const s = this.#byKey.get(key);
        if (s !== undefined) s.consecutive = 0;
      },
    };
  }

  #prune(): void {
    const now = this.#clock.now();
    for (const [k, s] of this.#byKey) if (s.openUntil <= now) this.#byKey.delete(k);
  }
}
