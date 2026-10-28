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
  /** Number prefixes an owner stored for this instance (`{ Story: 'B' }`); untrusted shape, re-validated on use. */
  readonly numberPrefixes?: Readonly<Record<string, unknown>>;
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

/** How a write would be approved for this caller (ADR-0013); the stdio host and HTTP access model decide it. */
export type ApprovalChannel = 'elicitation' | 'page' | 'unavailable' | 'not_required';

/** The agility-bridge workspace this request runs in (configuration, never Agility data). */
export interface WorkspaceInfo {
  readonly id: string;
  readonly name: string;
  /** Tool groups enabled for this caller. */
  readonly groups: readonly string[];
  readonly writes: { readonly enabled: boolean; readonly approval: ApprovalChannel };
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
  /** Offer `get_attachment`, the text content of one attachment (D-08, THREAT_MODEL A8). Off by default. */
  readonly attachmentDownload: boolean;
  /** Offer the composite reports (P6-07, D-101, THREAT_MODEL T3). Off by default. */
  readonly reports: boolean;
  /** Largest attachment `get_attachment` reads, counted on the stream (never the declared length). */
  readonly attachmentMaxBytes: number;
  /** Content types `get_attachment` may return, as `type/subtype` in lower case (checked on metadata and response). */
  readonly attachmentTypes: readonly string[];
}

/** Default text types of `get_attachment` (D-08). */
export const DEFAULT_ATTACHMENT_TYPES: readonly string[] = Object.freeze([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

/** Types that run or render in a client; refused even when a deployment lists them (THREAT_MODEL A8). */
export const ACTIVE_ATTACHMENT_TYPES: readonly string[] = Object.freeze([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'text/xml',
  'application/xml',
]);

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
  attachmentDownload: false,
  reports: false,
  attachmentMaxBytes: 1_048_576,
  attachmentTypes: DEFAULT_ATTACHMENT_TYPES,
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

/**
 * A budget for one tool that spends from the call's budget but never more than `max` (its declared cost). A tool whose
 * work depends on cold metadata stops at its declared cost; the metadata it loaded stays cached for the retry.
 */
export function capBudget(parent: Budget, max: number): Budget {
  const start = parent.used;
  const usedHere = () => parent.used - start;
  return {
    get limit() {
      return Math.min(parent.limit, start + max);
    },
    get used() {
      return parent.used;
    },
    get remaining() {
      return Math.max(0, Math.min(parent.remaining, max - usedHere()));
    },
    canSpend: (n = 1) => usedHere() + n <= max && parent.canSpend(n),
    spend(n = 1, what = 'an Agility request') {
      if (usedHere() + n > max) {
        throw new AbError(
          ErrorCode.BudgetExhausted,
          `This call reached its limit of ${max} Agility requests before ${what}.`,
          {
            hint: 'Repeat the call: the metadata it loaded is cached, so the next call needs fewer requests. Or ask for fewer fields or types.',
            details: { limitRequests: max, usedRequests: usedHere() },
            localDetails: true,
          },
        );
      }
      parent.spend(n, what);
    },
  };
}

/**
 * A budget for one section of a composite: it spends from the parent (so the call's total stays bounded) and counts
 * its own spend, so sections that run at the same time are each attributed exactly their own requests (P6-40; a
 * before/after reading of the parent would mix them up). The section's tool caps itself on top of this.
 */
export function childBudget(parent: Budget): Budget & { readonly used: number } {
  let used = 0;
  return {
    get limit() {
      return parent.limit;
    },
    get used() {
      return used;
    },
    get remaining() {
      return parent.remaining;
    },
    canSpend: (n = 1) => parent.canSpend(n),
    spend(n = 1, what = 'an Agility request') {
      parent.spend(n, what);
      used += n;
    },
  };
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
  readonly workspace: WorkspaceInfo;
  readonly credential: Credential;
  readonly projects: ProjectScope;
  readonly assetTypes: AssetTypeScope;
  readonly limits: Limits;
  readonly budget: Budget;
  readonly limiter: Limiter;
  readonly breaker: Breaker;
  /** Pinned at configuration time with the instance; never chosen by a request (L-055). */
  readonly fetch: FetchLike;
  /**
   * Names of the tools this caller may call, set by `buildMcpServer` from the tools it registered. A composite report
   * reads a section only through a tool listed here (L-037); absent means none (fail closed).
   */
  readonly grantedTools?: readonly string[];
  /**
   * Granted tools the per-call budget hides (declared cost above it), as name and cost, set by the host that filtered
   * them; `whoami` says so instead of leaving a silent gap (P6-36, L-115).
   */
  readonly hiddenByBudget?: ReadonlyArray<{ readonly name: string; readonly cost: number }>;
  /** The host's metadata service (P1-03); tools use `metadataFor(ctx)`. */
  readonly metadata?: MetadataService;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly random: Random;
  /**
   * Resolutions (member, team, project, sprint) already made by this request, so the sections of a composite do not
   * repeat them (P6-40). Created by `withMemo` inside one request's handler, never by a host and never shared across
   * requests (L-096): a second request resolves again.
   */
  readonly memo?: Map<string, Promise<unknown>>;
}

/** The context with a fresh resolution memo (one per request; an existing memo is kept). */
export function withMemo<T extends ToolContext>(ctx: T): T {
  return ctx.memo === undefined ? { ...ctx, memo: new Map() } : ctx;
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
