// SPDX-License-Identifier: Apache-2.0
// The optional exact, deployment-wide limiter on a Durable Object (P3-12, ADR-0010, THREAT_MODEL T1, T20, L-080, L-081,
// L-099). The Rate Limiting binding of P3-04 stays the default: it is per location and eventually consistent. With a
// `RL_SHARED` binding the keys below go to a Durable Object instead, which serialises every decision of its shard, so
// the limit holds across every isolate and location.
//
// Two pieces: `SharedLimiter`, the Durable Object class (token buckets for request limits and fixed-window counters
// for write limits, both in the object's SQLite-backed storage, which the Workers Free plan allows), and
// `SharedLimiterClient`, the Worker's side: a `RateLimiter` for requests and a `CounterStore` for writes.
//
// The class is a plain object with a `fetch` method, not a subclass of `cloudflare:workers`' `DurableObject`, so this
// file imports nothing from the runtime and the unit tests run it over a fake storage. No request data lives in module
// state: the object's state is the buckets and counters, and the client holds only the namespace binding (L-013).
//
// Failure policy (L-080), decided per control: request limits fail OPEN (the client reports the failure and the
// caller falls back to the binding and the per-isolate buckets); write counters fail CLOSED (the write limiter that
// uses the client refuses the write when it throws). Every call is a billed Durable Object request.
import type { LimitDecision, Rate, RateLimiter } from '@agility-bridge/http-app';

/** The Durable Object's storage, as much of it as is used (SQLite-backed on every plan). */
export interface ObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(options: { prefix: string; limit: number }): Promise<Map<string, T>>;
  setAlarm(time: number): Promise<void>;
  getAlarm(): Promise<number | null>;
}

export interface ObjectState {
  readonly storage: ObjectStorage;
}

interface Bucket {
  readonly tokens: number;
  readonly at: number;
  /** After this the bucket is full again, so the row can go. */
  readonly expiresAt: number;
}

interface Counter {
  readonly n: number;
  readonly expiresAt: number;
}

const BUCKET = 'b:';
const COUNTER = 'c:';
/** Expired rows deleted per alarm run (bounded work, L-097). */
const SWEEP = 200;
const SWEEP_EVERY_MS = 15 * 60_000;
const MAX_KEY = 256;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function isRate(rate: unknown): rate is Rate {
  const r = rate as Partial<Rate> | null;
  return (
    typeof r === 'object' &&
    r !== null &&
    Number.isFinite(r.limit) &&
    (r.limit as number) >= 1 &&
    (r.limit as number) <= 1_000_000 &&
    Number.isFinite(r.windowMs) &&
    (r.windowMs as number) >= 1_000 &&
    (r.windowMs as number) <= 86_400_000
  );
}

const validKey = (key: unknown): key is string =>
  typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY;

/**
 * The Durable Object. One instance holds one shard of keys; every call is one storage read and at most one write, and
 * the runtime's input gate keeps two calls from interleaving between them. Time is the object's own clock, never the
 * caller's, so isolates with skewed clocks cannot widen a limit.
 */
export class SharedLimiter {
  readonly #state: ObjectState;
  readonly #now: () => number;

  constructor(state: ObjectState, _env?: unknown, now: () => number = Date.now) {
    this.#state = state;
    this.#now = now;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return json({ error: 'body' }, 400);
    }
    const op = new URL(request.url).pathname.slice(1);
    if (!validKey(body['key'])) return json({ error: 'key' }, 400);
    const key = body['key'];
    switch (op) {
      case 'take':
      case 'peek':
        if (!isRate(body['rate'])) return json({ error: 'rate' }, 400);
        return json(await this.#bucket(key, body['rate'], op === 'take'));
      case 'increment': {
        const { max, expiresAt } = body;
        if (
          !Number.isInteger(max) ||
          (max as number) < 0 ||
          !Number.isFinite(expiresAt) ||
          (expiresAt as number) > this.#now() + 25 * 3_600_000
        ) {
          return json({ error: 'counter' }, 400);
        }
        return json({ n: await this.#increment(key, max as number, expiresAt as number) });
      }
      case 'get':
        return json({ n: await this.#read(key) });
      default:
        return json({ error: 'op' }, 404);
    }
  }

  /** Token bucket, the same arithmetic as the per-isolate `MemoryRateLimiter`. */
  async #bucket(key: string, rate: Rate, take: boolean): Promise<LimitDecision | { ok: boolean }> {
    const now = this.#now();
    const stored = await this.#state.storage.get<Bucket>(BUCKET + key);
    const tokens =
      stored === undefined || stored.expiresAt <= now
        ? rate.limit
        : Math.min(rate.limit, stored.tokens + (Math.max(0, now - stored.at) * rate.limit) / rate.windowMs);
    if (!take) return { ok: tokens >= 1 };
    const ok = tokens >= 1;
    const left = ok ? tokens - 1 : tokens;
    await this.#state.storage.put(BUCKET + key, {
      tokens: left,
      at: now,
      expiresAt: now + rate.windowMs,
    } satisfies Bucket);
    await this.#sweepLater(now);
    return ok
      ? { ok: true }
      : {
          ok: false,
          retryAfterSeconds: Math.max(1, Math.ceil(((1 - left) * rate.windowMs) / rate.limit / 1000)),
        };
  }

  /** The new count, or null when `max` would be exceeded (nothing is written then). */
  async #increment(key: string, max: number, windowEnd: number): Promise<number | null> {
    const now = this.#now();
    const stored = await this.#state.storage.get<Counter>(COUNTER + key);
    const live = stored !== undefined && stored.expiresAt > now ? stored : undefined;
    const next = (live?.n ?? 0) + 1;
    if (next > max) return null;
    await this.#state.storage.put(COUNTER + key, {
      n: next,
      // The window ends where the caller's key says (its window number), so every isolate agrees; never extended.
      expiresAt: live?.expiresAt ?? windowEnd,
    } satisfies Counter);
    await this.#sweepLater(now);
    return next;
  }

  async #read(key: string): Promise<number | null> {
    const stored = await this.#state.storage.get<Counter>(COUNTER + key);
    return stored === undefined || stored.expiresAt <= this.#now() ? null : stored.n;
  }

  async #sweepLater(now: number): Promise<void> {
    if ((await this.#state.storage.getAlarm()) === null)
      await this.#state.storage.setAlarm(now + SWEEP_EVERY_MS);
  }

  /** Deletes expired rows in a bounded slice and asks to run again while rows remain. */
  async alarm(): Promise<void> {
    const now = this.#now();
    const gone: string[] = [];
    let remain = false;
    for (const prefix of [BUCKET, COUNTER]) {
      const rows = await this.#state.storage.list<{ expiresAt: number }>({ prefix, limit: SWEEP });
      if (rows.size >= SWEEP) remain = true;
      for (const [key, row] of rows) {
        if (row.expiresAt <= now) gone.push(key);
        else remain = true;
      }
    }
    // The storage API deletes at most 128 keys at once.
    for (let i = 0; i < gone.length; i += 128) await this.#state.storage.delete(gone.slice(i, i + 128));
    if (remain) await this.#state.storage.setAlarm(now + SWEEP_EVERY_MS);
  }
}

/** The namespace binding, as much of it as the client uses. */
export interface SharedLimiterNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

/** Shards of keys: one object per shard, so one hot address cannot slow every other key's decisions. */
export const SHARDS = 16;
/** The longest a call to the object may take before it counts as failed. */
export const TIMEOUT_MS = 1_500;

/** FNV-1a over the key: a stable spread over the shards (no secrecy needed: the object only counts). */
export function shardOf(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % SHARDS;
}

export class SharedLimiterError extends Error {
  override name = 'SharedLimiterError';
}

/**
 * The Worker's side. `take`/`peek` throw `SharedLimiterError` when the object cannot answer: the composite limiter
 * (request limits) catches it and fails open; the write limiter (`increment`/`get`) lets it propagate and refuses.
 */
export class SharedLimiterClient implements RateLimiter {
  readonly #ns: SharedLimiterNamespace;
  readonly #timeoutMs: number;

  constructor(namespace: SharedLimiterNamespace, timeoutMs = TIMEOUT_MS) {
    this.#ns = namespace;
    this.#timeoutMs = timeoutMs;
  }

  async #call<T>(op: string, key: string, body: Record<string, unknown>): Promise<T> {
    try {
      const stub = this.#ns.get(this.#ns.idFromName(`rl:${shardOf(key)}`));
      const res = await stub.fetch(
        new Request(`https://limiter.invalid/${op}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key, ...body }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        }),
      );
      if (!res.ok) {
        await res.body?.cancel();
        throw new SharedLimiterError(`limiter answered ${res.status}`);
      }
      return (await res.json()) as T;
    } catch (error) {
      throw error instanceof SharedLimiterError
        ? error
        : new SharedLimiterError('limiter call failed', { cause: error });
    }
  }

  async take(key: string, rate: Rate): Promise<LimitDecision> {
    const answer = await this.#call<{ ok: boolean; retryAfterSeconds?: number }>('take', key, { rate });
    if (answer.ok === true) return { ok: true };
    if (answer.ok === false && typeof answer.retryAfterSeconds === 'number') {
      return { ok: false, retryAfterSeconds: answer.retryAfterSeconds };
    }
    throw new SharedLimiterError('limiter answered something else');
  }

  async peek(key: string, rate: Rate): Promise<boolean> {
    const answer = await this.#call<{ ok: boolean }>('peek', key, { rate });
    if (typeof answer.ok !== 'boolean') throw new SharedLimiterError('limiter answered something else');
    return answer.ok;
  }

  /** `CounterStore.increment`: the new count, or `null` over `max`. */
  async increment(key: string, options: { expiresAt: number; max: number }): Promise<number | null> {
    const answer = await this.#call<{ n: number | null }>('increment', key, {
      max: options.max,
      expiresAt: options.expiresAt,
    });
    if (answer.n !== null && !Number.isInteger(answer.n))
      throw new SharedLimiterError('limiter answered something else');
    return answer.n;
  }

  /** `CounterStore.get`: the count as text, or `null`. */
  async get(key: string): Promise<string | null> {
    const answer = await this.#call<{ n: number | null }>('get', key, {});
    if (answer.n === null) return null;
    if (!Number.isInteger(answer.n)) throw new SharedLimiterError('limiter answered something else');
    return String(answer.n);
  }
}

/** Which request-limit keys the Durable Object decides when it is bound (the rest stay on the binding backstop). */
export const SHARED_REQUEST_PREFIXES: readonly string[] = ['authfail:', 'signin:', 'oauth:'];
