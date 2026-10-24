// SPDX-License-Identifier: Apache-2.0
// The Workers-KV surface `@cloudflare/workers-oauth-provider` 1.2.x uses (`get` text/json, `put` with expiry,
// `delete`, `list` by prefix with a cursor), over the storage `kv` table (ADR-0006): SQLite on Node, D1 on Workers.
// Every provider key lives under `oauth:`, so the table's other users (sign-in state, sessions, setup links, our own
// markers) can never collide with it, and the expired-row purge reclaims abandoned grants and tokens too (L-086).
//
// Key metadata is dropped: the provider uses it only to skip reading grant records while it looks for grants to
// replace, and reads the record itself when a key carries none (correct, one extra read per grant of that user).
import type { KvStore } from '@agility-bridge/storage';

/** Prefix of every provider key in the `kv` table. */
export const OAUTH_KV_PREFIX = 'oauth:';
/** Most keys one `list` page returns (the store's own cap is 1,000). */
const LIST_PAGE = 100;

type GetType = 'text' | 'json';

interface ListKey {
  readonly name: string;
}

/** What the provider sees as `env.OAUTH_KV`. */
export interface OAuthKvNamespace {
  get(key: string, options?: GetType | { readonly type?: GetType }): Promise<unknown>;
  put(
    key: string,
    value: string,
    options?: { readonly expiration?: number; readonly expirationTtl?: number; readonly metadata?: unknown },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { readonly prefix?: string; readonly limit?: number; readonly cursor?: string }): Promise<{
    readonly keys: readonly ListKey[];
    readonly list_complete: boolean;
    readonly cursor?: string;
  }>;
}

/** The provider's KV namespace over `kv` (only the methods it calls; values are strings, as on Workers KV). */
export function oauthKvNamespace(kv: KvStore, now: () => number): OAuthKvNamespace {
  const full = (key: string): string => {
    if (typeof key !== 'string' || key === '') throw new TypeError('kv key must be a non-empty string');
    return `${OAUTH_KV_PREFIX}${key}`;
  };
  // The provider looks clients up by whatever `client_id` a caller sent: a key the store cannot hold reads as absent
  // (and deletes nothing) instead of failing the request.
  const storable = (key: string): boolean => /^[\x21-\x7e]{1,512}$/.test(`${OAUTH_KV_PREFIX}${key}`);
  return Object.freeze({
    async get(key: string, options?: GetType | { readonly type?: GetType }): Promise<unknown> {
      const type = typeof options === 'string' ? options : (options?.type ?? 'text');
      if (typeof key === 'string' && key !== '' && !storable(key)) return null;
      const value = await kv.get(full(key));
      if (value === null) return null;
      if (type === 'json') return JSON.parse(value) as unknown;
      if (type === 'text') return value;
      throw new TypeError(`unsupported kv get type: ${String(type)}`);
    },
    async put(
      key: string,
      value: string,
      options: { readonly expiration?: number; readonly expirationTtl?: number } = {},
    ): Promise<void> {
      if (typeof value !== 'string') throw new TypeError('kv values must be strings');
      // Workers KV: `expiration` is epoch seconds, `expirationTtl` seconds from now.
      const expiresAt =
        options.expiration !== undefined
          ? options.expiration * 1000
          : options.expirationTtl !== undefined
            ? now() + options.expirationTtl * 1000
            : null;
      await kv.set(full(key), value, { expiresAt });
    },
    async delete(key: string): Promise<void> {
      if (typeof key === 'string' && key !== '' && !storable(key)) return;
      await kv.delete(full(key));
    },
    async list(
      options: { readonly prefix?: string; readonly limit?: number; readonly cursor?: string } = {},
    ) {
      const limit = Math.min(options.limit ?? LIST_PAGE, LIST_PAGE);
      // The cursor is the last key of the previous page (without our prefix); the store lists in key order.
      const names = await kv.list(`${OAUTH_KV_PREFIX}${options.prefix ?? ''}`, {
        limit: limit + 1,
        ...(options.cursor === undefined ? {} : { after: `${OAUTH_KV_PREFIX}${options.cursor}` }),
      });
      const page = names.slice(0, limit).map((name) => name.slice(OAUTH_KV_PREFIX.length));
      const more = names.length > limit;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: !more,
        ...(more && page.length > 0 ? { cursor: page[page.length - 1] as string } : {}),
      };
    },
  });
}
