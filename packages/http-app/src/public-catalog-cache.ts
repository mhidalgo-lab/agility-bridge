// SPDX-License-Identifier: Apache-2.0
// The serialised answers of the anonymous public catalogue (P8-35, THREAT_MODEL T33, L-113): `initialize`, `server/discover`
// and `tools/list` are a function of the tool registry and the request's own protocol fields, so the bytes are kept for the
// life of the isolate and only the JSON-RPC `id` is substituted. Nothing in an entry comes from storage, a workspace
// name, a grant or a credential (the catalogue never sees them, D-64, T21); the key is the method and every request field
// the SDK could echo, so two requests that could be answered differently never share an entry. Bounded: a few entries, none
// large, the oldest dropped first. It is built inside `createHttpApp`, so it lives as long as the app (an isolate on Workers).

/** The methods whose answer is kept: the three the review measured (P-8). `ping` and notifications are tiny. */
const CACHED_METHODS: ReadonlySet<string> = new Set(['initialize', 'server/discover', 'tools/list']);
/** Entries kept; a client that varies its `initialize` parameters evicts the oldest, nothing more. */
const MAX_ENTRIES = 16;
/** The largest answer kept (the catalogue is about 40 KB). */
const MAX_ENTRY_CHARS = 128 * 1024;
/** The longest key built: a request with larger parameters is simply answered the normal way. */
const MAX_KEY_CHARS = 2048;

/** The request headers the answer can depend on: the protocol era, the routing headers and the answer's framing. */
const KEY_HEADERS = ['accept', 'mcp-protocol-version', 'mcp-method', 'mcp-name'] as const;

/** Headers that describe the original body's length, which the substituted id changes. */
const FRAMING: ReadonlySet<string> = new Set(['content-length', 'transfer-encoding']);

interface CachedAnswer {
  readonly status: number;
  readonly headers: [string, string][];
  /** The body before and after the JSON-RPC `id` value. */
  readonly before: string;
  readonly after: string;
}

export interface PublicAnswerCache {
  /** The key for a request, or undefined when it is not cacheable (another method, no usable id, oversize). */
  keyFor(message: unknown, header: (name: string) => string | undefined): string | undefined;
  /** The answer for `key` with this request's `id`, or undefined. */
  serve(key: string, id: string | number): Response | undefined;
  /** Remembers a built answer. Returns false (and keeps nothing) when the body cannot be split around its `id`. */
  remember(key: string, id: string | number, status: number, headers: Headers, body: string): boolean;
  readonly size: number;
}

/**
 * A JSON-RPC id the cache can substitute: a string or a safe integer. The SDK refuses other ids (a fractional number, say)
 * with an error, which must stay the answer to such a request: they are never kept and never served from the kept bytes.
 */
export const usableId = (id: unknown): id is string | number =>
  typeof id === 'string' || Number.isSafeInteger(id);

/** Splits `body` around the one place its (top-level) `id` is written; undefined when that cannot be shown. */
function splitAtId(body: string, id: string | number): readonly [string, string] | undefined {
  const needle = `"id":${JSON.stringify(id)}`;
  const at = body.indexOf(needle);
  if (at < 0 || body.indexOf(needle, at + needle.length) >= 0) return undefined;
  // The one occurrence has to be the message's own id: parse the message once, here, and compare.
  const data = body.startsWith('{')
    ? body
    : body
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .pop();
  try {
    if ((JSON.parse(data ?? '') as { id?: unknown }).id !== id) return undefined;
  } catch {
    return undefined;
  }
  return [body.slice(0, at + 5), body.slice(at + needle.length)];
}

export function createPublicAnswerCache(): PublicAnswerCache {
  const answers = new Map<string, CachedAnswer>();
  return {
    keyFor(message, header) {
      if (message === null || typeof message !== 'object' || Array.isArray(message)) return undefined;
      const m = message as { method?: unknown; id?: unknown; params?: unknown };
      if (typeof m.method !== 'string' || !CACHED_METHODS.has(m.method) || !usableId(m.id)) return undefined;
      const key = JSON.stringify([m.method, KEY_HEADERS.map((h) => header(h) ?? null), m.params ?? null]);
      return key.length <= MAX_KEY_CHARS ? key : undefined;
    },
    serve(key, id) {
      const hit = answers.get(key);
      if (hit === undefined) return undefined;
      return new Response(`${hit.before}${JSON.stringify(id)}${hit.after}`, {
        status: hit.status,
        headers: hit.headers,
      });
    },
    remember(key, id, status, headers, body) {
      if (status !== 200 || body.length > MAX_ENTRY_CHARS) return false;
      const split = splitAtId(body, id);
      if (split === undefined) return false;
      if (!answers.has(key) && answers.size >= MAX_ENTRIES) {
        const oldest = answers.keys().next().value;
        if (oldest !== undefined) answers.delete(oldest);
      }
      answers.set(key, {
        status,
        headers: [...headers.entries()].filter(([name]) => !FRAMING.has(name)),
        before: split[0],
        after: split[1],
      });
      return true;
    },
    get size() {
      return answers.size;
    },
  };
}
