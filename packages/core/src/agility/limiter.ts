// SPDX-License-Identifier: Apache-2.0
import type { Limiter } from '../context.ts';

/** A counting semaphore: at most `max` tasks run at once, the rest wait in order (ADR-0010). */
export class Semaphore implements Limiter {
  readonly max: number;
  #active = 0;
  readonly #queue: Array<() => void> = [];

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError('Semaphore size must be a positive integer.');
    this.max = max;
  }

  get active(): number {
    return this.#active;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active < this.max) this.#active++;
    else await new Promise<void>((resolve) => this.#queue.push(resolve));
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next waiter, so a newcomer cannot overtake the queue.
      const next = this.#queue.shift();
      if (next === undefined) this.#active--;
      else next();
    }
  }
}

/**
 * One semaphore per instance and credential, owned by the host for the life of the process (state about upstream
 * capacity, not request data: T21 allows it). Idle semaphores are dropped once more than `maxKeys` exist.
 */
export class CredentialLimiters {
  readonly #size: number;
  readonly #maxKeys: number;
  readonly #perCall: boolean;
  readonly #byKey = new Map<string, Semaphore>();

  /**
   * `perCall` (Workers, L-096): every `for()` returns a new semaphore, so a call never waits for a slot another request
   * holds; concurrency is then bounded per call, and Workers bounds connections per request itself.
   */
  constructor(
    options: { readonly concurrency?: number; readonly maxKeys?: number; readonly perCall?: boolean } = {},
  ) {
    this.#size = options.concurrency ?? 5;
    this.#maxKeys = options.maxKeys ?? 10_000;
    this.#perCall = options.perCall ?? false;
  }

  for(instanceId: string, credentialId: string): Limiter {
    if (this.#perCall) return new Semaphore(this.#size);
    const key = `${instanceId}\u0000${credentialId}`;
    let sem = this.#byKey.get(key);
    if (sem === undefined) {
      if (this.#byKey.size >= this.#maxKeys) {
        for (const [k, s] of this.#byKey) if (s.active === 0 && s.waiting === 0) this.#byKey.delete(k);
      }
      sem = new Semaphore(this.#size);
      this.#byKey.set(key, sem);
    }
    return sem;
  }
}
