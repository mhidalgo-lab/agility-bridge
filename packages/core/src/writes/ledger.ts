// SPDX-License-Identifier: Apache-2.0
// The approval ledger (ADR-0013): single-use records that an approval exists for exactly one change by one actor.
// Two kinds of entry, both consumed with an atomic `take` so a replay finds nothing (T31, L-073):
// - a *round* entry, opened when a multi round-trip question is asked and taken when the answer comes back;
// - a *grant*, recorded by an out-of-band approval (the approval page, P7-02) and taken when the agent repeats the call.
// Remote modes back it with the storage `kv` table; stdio with process memory (nothing is shared there).
import type { Clock } from '../context.ts';

export interface LedgerEntry {
  /** Hash of the canonical mutation (`mutationHash`). */
  readonly hash: string;
  readonly actor: string;
  readonly tool: string;
  /** Epoch ms; an entry past it is refused even if the store still holds it. */
  readonly expiresAt: number;
}

/** The part of the storage `kv` table the ledger needs (`KvStore` satisfies it structurally). */
export interface LedgerStore {
  set(key: string, value: string, options?: { expiresAt?: number | null }): Promise<void>;
  /** Removes and returns a live value in one step: of concurrent callers exactly one gets it. */
  take(key: string): Promise<string | null>;
}

const part = (s: string): string => encodeURIComponent(s);

export class ApprovalLedger {
  readonly #store: LedgerStore;
  readonly #clock: Clock;

  constructor(store: LedgerStore, clock: Clock) {
    this.#store = store;
    this.#clock = clock;
  }

  openRound(nonce: string, entry: LedgerEntry): Promise<void> {
    return this.#put(`wr:round:${part(nonce)}`, entry);
  }

  takeRound(nonce: string): Promise<LedgerEntry | null> {
    return this.#take(`wr:round:${part(nonce)}`);
  }

  /** Records an out-of-band approval (P7-02): valid for this actor and this hash only, until `expiresAt`. */
  grant(entry: LedgerEntry): Promise<void> {
    return this.#put(`wr:ok:${part(entry.actor)}:${entry.hash}`, entry);
  }

  takeGrant(actor: string, hash: string): Promise<LedgerEntry | null> {
    return this.#take(`wr:ok:${part(actor)}:${hash}`);
  }

  #put(key: string, entry: LedgerEntry): Promise<void> {
    return this.#store.set(key, JSON.stringify(entry), { expiresAt: entry.expiresAt });
  }

  async #take(key: string): Promise<LedgerEntry | null> {
    const raw = await this.#store.take(key);
    if (raw === null) return null;
    try {
      const e = JSON.parse(raw) as Record<string, unknown>;
      if (
        typeof e['hash'] !== 'string' ||
        typeof e['actor'] !== 'string' ||
        typeof e['tool'] !== 'string' ||
        typeof e['expiresAt'] !== 'number' ||
        e['expiresAt'] <= this.#clock.now()
      ) {
        return null;
      }
      return { hash: e['hash'], actor: e['actor'], tool: e['tool'], expiresAt: e['expiresAt'] };
    } catch {
      return null;
    }
  }
}

/** An in-process store (stdio, tests): bounded, expired entries dropped as it grows. */
export function memoryLedgerStore(clock: Clock, maxEntries = 1_000): LedgerStore {
  const data = new Map<string, { value: string; expiresAt: number }>();
  return {
    async set(key, value, options) {
      const now = clock.now();
      if (data.size >= maxEntries) {
        for (const [k, v] of data) if (v.expiresAt <= now) data.delete(k);
        const oldest = data.keys().next();
        if (data.size >= maxEntries && !oldest.done) data.delete(oldest.value);
      }
      data.set(key, { value, expiresAt: options?.expiresAt ?? Number.POSITIVE_INFINITY });
    },
    async take(key) {
      const entry = data.get(key);
      data.delete(key);
      return entry !== undefined && entry.expiresAt > clock.now() ? entry.value : null;
    },
  };
}
