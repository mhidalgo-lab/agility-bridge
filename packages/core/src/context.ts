// SPDX-License-Identifier: Apache-2.0
import { AbError, ErrorCode } from './errors.ts';
import type { Logger } from './logger.ts';
import type { MetadataService } from './metadata/service.ts';
import type { Secret } from './secret.ts';

/** The Agility instance a request talks to. Defined by an owner or admin, never by a caller (ADR-0008). */
export interface InstanceRef {
  /** Stable id (storage id, or "env" in stdio env mode). */
  readonly id: string;
  /** Canonical base URL, e.g. https://www7.v1host.com/MyInstance (ADR-0014). */
  readonly baseUrl: string;
}

/** The Agility credential a request runs with. The token is only readable through `Secret.reveal()`. */
export interface Credential {
  /** Stable id used for cache keys and limiter scoping; never the token. */
  readonly id: string;
  /** `personal` (bring-your-own-token) or `shared` (read-only grants only, ADR-0008). */
  readonly kind: 'personal' | 'shared';
  readonly token: Secret;
}

/** The Agility projects (`Scope`) this request may read: the intersection computed upstream (ADR-0008). */
export interface ProjectScope {
  /** OID tokens (`Scope:1234`); empty means every project the member can see (stdio without `AB_PROJECTS`). */
  readonly allowed: readonly string[];
  /** Include descendants of the allowed projects (`ChildrenMeAndDown`). */
  readonly includeChildren: boolean;
}

/** Asset types this request may read, by Agility API name. `allow` undefined means every type the instance exposes. */
export interface AssetTypeScope {
  readonly allow?: readonly string[];
  readonly deny: readonly string[];
}

/** Query limits (tool conventions; units in the names, L-042). Tightened per grant upstream. */
export interface Limits {
  /** Default rows per list call. */
  readonly defaultRows: number;
  /** Most rows a caller may ask for in one call (hard cap 1,000). */
  readonly maxRows: number;
  readonly maxFields: number;
  readonly maxNestingDepth: number;
  readonly maxAggregations: number;
  readonly maxAnyOfGroups: number;
  /** Upstream response cap, enforced while streaming (ADR-0010). */
  readonly maxResponseBytes: number;
  /** Timeout of one Agility request, body included (ADR-0010: 20 s). */
  readonly requestTimeoutMs: number;
  /** Oldest point in time an `as_of` read may ask for (L-060). */
  readonly maxAsOfAgeDays: number;
  /** Longest `time_range` window (L-060). */
  readonly maxTimeRangeDays: number;
  /** Include member emails in output (D-06, off by default). */
  readonly memberEmails: boolean;
}

/** D-07 starting limits; 512 KiB is the Workers Free response cap (ADR-0010), raised by hosts that allow more. */
export const DEFAULT_LIMITS: Limits = Object.freeze({
  defaultRows: 25,
  maxRows: 100,
  maxFields: 30,
  maxNestingDepth: 2,
  maxAggregations: 5,
  maxAnyOfGroups: 3,
  maxResponseBytes: 512 * 1024,
  requestTimeoutMs: 20_000,
  maxAsOfAgeDays: 365,
  maxTimeRangeDays: 366,
  memberEmails: false,
});

/** Per-request budget of Agility requests (ADR-0010). Every attempt, retries included, spends from it. */
export interface Budget {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  canSpend(n?: number): boolean;
  /** Spend `n` requests or throw AB_BUDGET_EXHAUSTED. */
  spend(n?: number, what?: string): void;
}

/** Bounds concurrent Agility calls for one credential (ADR-0010: per-credential semaphore). */
export interface Limiter {
  run<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * The circuit breaker of one instance and credential (ADR-0010). Hosts keep the state per process, keyed by both, so
 * one member's throttling never blocks another (`CircuitBreakers` in `agility/breaker.ts`).
 */
export interface Breaker {
  /** Milliseconds until the breaker closes again; 0 when closed. */
  openForMs(): number;
  onRateLimited(retryAfterMs?: number): void;
  onSuccess(): void;
}

/** The `fetch` the Agility client uses: the global one, or one with a custom CA dispatcher on Node (ADR-0014). */
export type FetchLike = (request: Request) => Promise<Response>;

export interface Clock {
  now(): number;
}

export const systemClock: Clock = Object.freeze({ now: () => Date.now() });

/** Randomness through one seam, so tests can be deterministic. */
export interface Random {
  /** A random UUID (request ids, envelope markers). */
  uuid(): string;
  /** `n` random bytes. */
  bytes(n: number): Uint8Array;
}

export const webCryptoRandom: Random = Object.freeze({
  uuid: () => crypto.randomUUID(),
  bytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
});

/**
 * Everything a tool handler may use. Built **per request**, frozen, and passed explicitly: nothing request-scoped may
 * live in module state (THREAT_MODEL T21, L-013).
 */
export interface ToolContext {
  readonly requestId: string;
  readonly instance: InstanceRef;
  readonly credential: Credential;
  readonly projects: ProjectScope;
  readonly assetTypes: AssetTypeScope;
  readonly limits: Limits;
  readonly budget: Budget;
  readonly limiter: Limiter;
  readonly breaker: Breaker;
  /** Pinned at configuration time with the instance; never chosen by a request (L-055). */
  readonly fetch: FetchLike;
  /** The host's metadata service (P1-03); tools use `metadataFor(ctx)`. */
  readonly metadata?: MetadataService;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly random: Random;
}

/** A counting budget. One instance per request. */
export function createBudget(limit: number): Budget {
  let used = 0;
  return {
    limit,
    get used() {
      return used;
    },
    get remaining() {
      return Math.max(0, limit - used);
    },
    canSpend: (n = 1) => used + n <= limit,
    spend(n = 1, what = 'an Agility request') {
      if (used + n > limit) {
        throw new AbError(ErrorCode.BudgetExhausted, `The request budget ran out before ${what}.`, {
          hint: 'Narrow the request (fewer rows, fewer fields, a smaller window), or ask for a partial result.',
          details: { limitRequests: limit, usedRequests: used },
          localDetails: true,
        });
      }
      used += n;
    },
  };
}

/** A limiter that applies no bound (tests). Hosts use a per-credential semaphore (P1-02). */
export const unboundedLimiter: Limiter = Object.freeze({ run: <T>(task: () => Promise<T>) => task() });

/** A breaker that never opens (tests and hosts that do not throttle). */
export const closedBreaker: Breaker = Object.freeze({
  openForMs: () => 0,
  onRateLimited: () => {},
  onSuccess: () => {},
});

/** Freeze a context so a handler cannot change what later code of the same request sees. */
export function freezeContext(ctx: ToolContext): ToolContext {
  return Object.freeze({ ...ctx });
}
