// SPDX-License-Identifier: Apache-2.0
// Abuse controls of the unauthenticated OAuth endpoints (P5-09, THREAT_MODEL T10, T11, T20, L-079, L-081). One limiter
// design for every surface: fixed-window counters in the shared `kv` table, taken with the store's atomic
// `increment` (SQLite on Node, D1 on Workers), so the count is deployment-wide on every host and an isolate's memory is
// never the authority (L-081, L-086). Per address first, then the deployment, so one source stops at its own limit and
// cannot use up the shared budget for the others (relic-bridge M1, L-251). Web-standard only.
//
// Cost on D1 (L-097): a taken unit is one row write; a refused increment writes nothing, and once a counter has refused,
// the refusal is remembered in the isolate until its window ends, so a flood costs a handful of writes and no reads.
// What is remembered is a hashed counter name and a time: no request data, and losing it only costs one more refused
// increment (L-013 allows this kind of cache; L-096: completed values only).
import type { KvStore } from '@agility-bridge/storage';

/** Surfaces limited here (the registration and fetch caps of P5-03 keep their own per-address counters). */
export type AbuseSurface = 'authorize' | 'consent' | 'token_failure' | 'registration' | 'metadata_fetch';

export interface AbuseRefusal {
  readonly surface: AbuseSurface;
  /** Which counter ran out: the caller's address, or the deployment. */
  readonly scope: 'address' | 'deployment';
  readonly limit: number;
  readonly retryAfterSeconds: number;
  /** The first refusal of this surface and scope in its window: the one the caller audits (T20). */
  readonly first: boolean;
}

/** Prefix of every counter and audit marker this module writes (outside the provider's `oauth:` namespace). */
export const ABUSE_PREFIX = 'oauth-abuse:';
const AUDIT_MARKER_PREFIX = 'oauth-abuse-audit:';
/** Remembered refusals at most (the least recently added go first). */
const MAX_REMEMBERED = 2_000;

export interface AbuseGuardDeps {
  readonly kv: KvStore;
  readonly now: () => number;
  readonly onError: (surface: AbuseSurface, error: unknown) => void;
}

export interface AbuseGuard {
  /**
   * Takes one unit for `surface` from the caller's counter and then the deployment's (`null` = no such limit). Resolves
   * null when the request may go on, else the refusal.
   */
  take(spec: TakeSpec): Promise<AbuseRefusal | null>;
  /** Whether the caller (or, for an address that already failed, the deployment) is over the limit; takes nothing. */
  blocked(spec: PeekSpec): Promise<AbuseRefusal | null>;
  /** Counts one failure against the caller's counter and the deployment's, up to their limits. */
  fail(spec: PeekSpec): Promise<void>;
}

export interface TakeSpec {
  readonly surface: AbuseSurface;
  /** Hash of the caller's address (never the address itself). */
  readonly address?: string;
  readonly addressLimit?: number | null;
  readonly deploymentLimit: number | null;
  readonly windowSeconds: number;
}

export interface PeekSpec {
  readonly surface: AbuseSurface;
  readonly address: string;
  readonly addressLimit: number;
  readonly deploymentLimit: number;
  readonly windowSeconds: number;
}

export function createAbuseGuard(deps: AbuseGuardDeps): AbuseGuard {
  const { kv, now } = deps;
  /** Counter name -> when its refusal ends (ms). Insertion order is eviction order. */
  const remembered = new Map<string, number>();
  const seenMarkers = new Set<string>();

  const windowOf = (windowSeconds: number): number => Math.floor(now() / 1000 / windowSeconds);
  const endOf = (window: number, windowSeconds: number): number => (window + 1) * windowSeconds * 1000;
  const retryAfter = (window: number, windowSeconds: number): number =>
    Math.max(1, Math.ceil((endOf(window, windowSeconds) - now()) / 1000));

  const remember = (key: string, until: number): void => {
    remembered.delete(key);
    remembered.set(key, until);
    while (remembered.size > MAX_REMEMBERED) {
      const oldest = remembered.keys().next();
      if (oldest.done === true) break;
      remembered.delete(oldest.value);
    }
  };

  const refuse = async (
    surface: AbuseSurface,
    scope: AbuseRefusal['scope'],
    limit: number,
    window: number,
    windowSeconds: number,
  ): Promise<AbuseRefusal> => {
    // One audit row per window, surface and scope: an anonymous flood must not become an audit-row flood (T20).
    // The isolate remembers the markers it has seen, so a refused flood costs no query here either.
    let first = false;
    const marker = `${AUDIT_MARKER_PREFIX}${surface}:${scope}:${window}`;
    if (!seenMarkers.has(marker)) {
      try {
        first = await kv.setIfAbsent(marker, '1', {
          expiresAt: endOf(window, windowSeconds) + windowSeconds * 1000,
        });
        if (seenMarkers.size >= 200) seenMarkers.clear();
        seenMarkers.add(marker);
      } catch (error) {
        deps.onError(surface, error);
      }
    }
    const refusal: AbuseRefusal = {
      surface,
      scope,
      limit,
      retryAfterSeconds: retryAfter(window, windowSeconds),
      first,
    };
    return refusal;
  };

  /** One counter: true when a unit was taken, false when it is full. Remembers a full counter until its window ends. */
  const takeOne = async (
    key: string,
    limit: number,
    window: number,
    windowSeconds: number,
  ): Promise<boolean> => {
    const until = remembered.get(key);
    if (until !== undefined) {
      if (until > now()) return false;
      remembered.delete(key);
    }
    const value = await kv.increment(key, { expiresAt: endOf(window, windowSeconds), max: limit });
    if (value === null) {
      remember(key, endOf(window, windowSeconds));
      return false;
    }
    return true;
  };

  const counterKey = (surface: AbuseSurface, scope: string, window: number): string =>
    `${ABUSE_PREFIX}${surface}:${scope}:${window}`;

  return Object.freeze({
    async take(spec: TakeSpec): Promise<AbuseRefusal | null> {
      const window = windowOf(spec.windowSeconds);
      try {
        if (spec.address !== undefined && spec.addressLimit !== undefined && spec.addressLimit !== null) {
          const mine = counterKey(spec.surface, `a:${spec.address}`, window);
          if (!(await takeOne(mine, spec.addressLimit, window, spec.windowSeconds))) {
            return await refuse(spec.surface, 'address', spec.addressLimit, window, spec.windowSeconds);
          }
        }
        if (spec.deploymentLimit !== null) {
          const all = counterKey(spec.surface, 'all', window);
          if (!(await takeOne(all, spec.deploymentLimit, window, spec.windowSeconds))) {
            return await refuse(spec.surface, 'deployment', spec.deploymentLimit, window, spec.windowSeconds);
          }
        }
      } catch (error) {
        // Fail open (L-080): a broken counter store must not turn the sign-in into an outage; the request limiter and
        // the storage the request needs anyway are still in front of it.
        deps.onError(spec.surface, error);
      }
      return null;
    },

    async blocked(spec: PeekSpec): Promise<AbuseRefusal | null> {
      const window = windowOf(spec.windowSeconds);
      try {
        const mine = counterKey(spec.surface, `a:${spec.address}`, window);
        const until = remembered.get(mine);
        const own =
          until !== undefined && until > now() ? spec.addressLimit : Number((await kv.get(mine)) ?? '0');
        if (own >= spec.addressLimit) {
          remember(mine, endOf(window, spec.windowSeconds));
          return await refuse(spec.surface, 'address', spec.addressLimit, window, spec.windowSeconds);
        }
        // The deployment limit only turns away addresses that have already failed in this window: a client with a clean
        // record is not locked out by someone else's failures (L-079).
        if (own > 0) {
          const all = Number((await kv.get(counterKey(spec.surface, 'all', window))) ?? '0');
          if (all >= spec.deploymentLimit) {
            return await refuse(spec.surface, 'deployment', spec.deploymentLimit, window, spec.windowSeconds);
          }
        }
      } catch (error) {
        deps.onError(spec.surface, error);
      }
      return null;
    },

    async fail(spec: PeekSpec): Promise<void> {
      const window = windowOf(spec.windowSeconds);
      const expiresAt = endOf(window, spec.windowSeconds);
      try {
        await kv.increment(counterKey(spec.surface, `a:${spec.address}`, window), {
          expiresAt,
          max: spec.addressLimit,
        });
        await kv.increment(counterKey(spec.surface, 'all', window), { expiresAt, max: spec.deploymentLimit });
      } catch (error) {
        deps.onError(spec.surface, error);
      }
    },
  });
}
