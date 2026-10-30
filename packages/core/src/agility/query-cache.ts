// SPDX-License-Identifier: Apache-2.0
// The query cache (P8-01, ADR-0010, THREAT_MODEL T16, L-098, L-113, L-116): repeated `query.v1` reads answered from a
// bounded in-memory LRU, optionally with a shared tier whose bodies are encrypted (the Workers Cache API). Every entry
// id is a keyed hash over every scope dimension of the request (instance, workspace, grant, credential or pass-through
// identity, projects, asset types, limits and the normalised compiled query), so entries of different scopes can never
// meet. Cached bodies are Agility data and stay untrusted: they are re-parsed on every hit and go through the same
// shaper as a live answer. Writes never read or fill it, and a hit spends nothing from the budget (L-116).
import type { Clock, ToolContext } from '../context.ts';
import type { Logger } from '../logger.ts';
import type { AgilityResponse } from './client.ts';

/** Longest a cached answer lives. Moving windows (`today`, "last 7 days") make longer lifetimes misleading. */
export const MAX_QUERY_CACHE_TTL_SECONDS = 60;

export type SharedTierStatus = 'unverified' | 'verified' | 'unavailable';

/**
 * A tier shared across isolates (the Workers Cache API). It only ever sees entry ids (keyed hashes) and text; the
 * implementation encrypts the text before it leaves the isolate and reports whether a read-back proved it works.
 */
export interface SharedTier {
  get(id: string): Promise<string | undefined>;
  set(id: string, text: string, ttlMs: number): Promise<void>;
  status(): SharedTierStatus;
}

export interface QueryCacheOptions {
  /** Entry lifetime in milliseconds (1 to 60,000). */
  readonly ttlMs: number;
  /** Keyed hash (hex) used for entry ids: the keyring's `cache-id` purpose, or a random per-process key. */
  readonly mac: (data: string) => Promise<string>;
  readonly clock: Clock;
  readonly maxEntries?: number;
  /** Total characters of cached text held in memory. */
  readonly maxBytes?: number;
  /** Largest single entry; bigger answers are not cached. */
  readonly maxEntryBytes?: number;
  readonly shared?: SharedTier;
  readonly logger?: Logger;
}

/** What a caller's context contributes to every entry id, besides the query: set by the host from the resolved access. */
export interface QueryCacheScope {
  readonly cache: QueryCache;
  /** The grant (or `stdio`) the request runs under. */
  readonly grantId: string;
  /** Whose Agility data it is: `cred:<credential id>`, or `pt:<token fingerprint>` for a pass-through caller. */
  readonly principal: string;
}

export interface QueryCacheInfo {
  readonly mode: 'memory' | 'memory+shared';
  readonly ttlSeconds: number;
  readonly shared: SharedTierStatus | 'off';
  readonly entries: number;
  readonly hits: number;
  readonly misses: number;
}

interface Entry {
  readonly text: string;
  readonly until: number;
}

/** JSON with object keys sorted, so equal queries written in another key order share an entry. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const o = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(o).sort()) {
    if (o[k] === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${canonicalJson(o[k])}`);
  }
  return `{${parts.join(',')}}`;
}

/** What the shared tier stores: the time Agility was asked, then the text. An entry without it is a miss. */
function splitStored(stored: string): { writtenAt: number; text: string } | undefined {
  const m = /^(\d{1,15}):/.exec(stored);
  return m === null ? undefined : { writtenAt: Number(m[1]), text: stored.slice(m[0].length) };
}

/** A random per-process keyed hash for hosts without a keyring (stdio); the key is made on first use and ids never leave the process. */
export function randomMac(): (data: string) => Promise<string> {
  let key: ReturnType<typeof crypto.subtle.importKey> | undefined;
  return async (data) => {
    key ??= crypto.subtle.importKey(
      'raw',
      crypto.getRandomValues(new Uint8Array(32)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key, new TextEncoder().encode(data)));
    return Array.from(sig, (byte) => byte.toString(16).padStart(2, '0')).join('');
  };
}

export class QueryCache {
  readonly #opts: QueryCacheOptions;
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #maxEntryBytes: number;
  readonly #entries = new Map<string, Entry>();
  #bytes = 0;
  #hits = 0;
  #misses = 0;

  constructor(options: QueryCacheOptions) {
    if (
      !Number.isInteger(options.ttlMs) ||
      options.ttlMs < 1 ||
      options.ttlMs > MAX_QUERY_CACHE_TTL_SECONDS * 1000
    ) {
      throw new RangeError(`The query cache TTL must be 1-${MAX_QUERY_CACHE_TTL_SECONDS} s.`);
    }
    this.#opts = options;
    this.#maxEntries = options.maxEntries ?? 200;
    this.#maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.#maxEntryBytes = options.maxEntryBytes ?? 256 * 1024;
  }

  /**
   * The entry id of one read. Every dimension comes from the same context the request runs with, so a caller cannot
   * reach another scope's entry (T16, L-113).
   */
  key(ctx: ToolContext, scope: QueryCacheScope, endpoint: string, body: unknown): Promise<string> {
    return this.#opts.mac(
      canonicalJson({
        v: 1,
        endpoint,
        instance: { id: ctx.instance.id, url: ctx.instance.baseUrl },
        workspace: ctx.workspace.id,
        grant: scope.grantId,
        principal: scope.principal,
        credentialKind: ctx.credential.kind,
        projects: ctx.projects,
        assetTypes: ctx.assetTypes,
        limits: ctx.limits,
        query: body,
      }),
    );
  }

  /** The text cached under `id`, from memory or (when `shared`) the shared tier. A broken tier is a miss. */
  async get(id: string, shared: boolean): Promise<string | undefined> {
    const now = this.#opts.clock.now();
    const hit = this.#entries.get(id);
    if (hit !== undefined) {
      if (hit.until > now) {
        // Most recently used goes last.
        this.#entries.delete(id);
        this.#entries.set(id, hit);
        this.#hits++;
        return hit.text;
      }
      this.#drop(id, hit);
    }
    const tier = shared ? this.#opts.shared : undefined;
    if (tier !== undefined) {
      try {
        const stored = await tier.get(id);
        const written = stored === undefined ? undefined : splitStored(stored);
        // The copy keeps the age it had, so an answer is never served past one TTL since Agility was asked (Q-1).
        if (written !== undefined) {
          const writtenAt = Math.min(written.writtenAt, now);
          if (writtenAt + this.#opts.ttlMs > now) {
            this.#remember(id, written.text, now, writtenAt + this.#opts.ttlMs);
            this.#hits++;
            return written.text;
          }
        }
      } catch (error) {
        this.#opts.logger?.warn('query cache shared tier read failed', { error: (error as Error).name });
      }
    }
    this.#misses++;
    return undefined;
  }

  /** Whether an answer of this many response bytes can be stored; checked before it is encoded (P-4). */
  accepts(responseBytes: number): boolean {
    return responseBytes <= this.#maxEntryBytes;
  }

  async put(id: string, text: string, shared: boolean): Promise<void> {
    if (text.length > this.#maxEntryBytes) return;
    const now = this.#opts.clock.now();
    this.#remember(id, text, now, now + this.#opts.ttlMs);
    const tier = shared ? this.#opts.shared : undefined;
    if (tier === undefined) return;
    try {
      await tier.set(id, `${now}:${text}`, this.#opts.ttlMs);
    } catch (error) {
      this.#opts.logger?.warn('query cache shared tier write failed', { error: (error as Error).name });
    }
  }

  #remember(id: string, text: string, now: number, until: number): void {
    const old = this.#entries.get(id);
    if (old !== undefined) this.#drop(id, old);
    this.#entries.set(id, { text, until });
    this.#bytes += text.length;
    // Oldest first: expired entries, then the least recently used, until both bounds hold.
    for (const [k, e] of this.#entries) {
      if (k === id) break;
      if (this.#entries.size <= this.#maxEntries && this.#bytes <= this.#maxBytes && e.until > now) break;
      this.#drop(k, e);
    }
  }

  #drop(id: string, entry: Entry): void {
    this.#entries.delete(id);
    this.#bytes -= entry.text.length;
  }

  /** After a local admin change to instances, credentials, workspaces, grants or tokens. */
  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  get size(): number {
    return this.#entries.size;
  }

  get ttlMs(): number {
    return this.#opts.ttlMs;
  }

  info(): QueryCacheInfo {
    const shared = this.#opts.shared;
    return {
      mode: shared === undefined ? 'memory' : 'memory+shared',
      ttlSeconds: Math.round(this.#opts.ttlMs / 1000),
      shared: shared === undefined ? 'off' : shared.status(),
      entries: this.#entries.size,
      hits: this.#hits,
      misses: this.#misses,
    };
  }
}

/** The stored form of a response: what a hit rebuilds. Re-parsed on every hit so no caller shares a mutable object. */
export function encodeResponse(res: AgilityResponse<unknown>): string {
  return JSON.stringify({ s: res.status, b: res.bytes, d: res.data });
}

export function decodeResponse<T>(text: string): AgilityResponse<T> | undefined {
  try {
    const v = JSON.parse(text) as { s?: unknown; b?: unknown; d?: unknown };
    if (typeof v.s !== 'number' || typeof v.b !== 'number' || !('d' in v)) return undefined;
    return { status: v.s, bytes: v.b, data: v.d as T };
  } catch {
    return undefined;
  }
}
