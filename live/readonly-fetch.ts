// SPDX-License-Identifier: Apache-2.0
// P0-12 (D-01, THREAT_MODEL A15): every request the live harness sends to the third-party tenant goes through this
// guard. Only reads reach Agility: GET on meta.v1 and rest-1.v1 Data/Hist, POST on query.v1 (read-only by design).
// Anything else (another endpoint, method, host, an `op=` operation, a redirect) is refused before or instead of sending.

export class ReadOnlyViolation extends Error {
  override name = 'ReadOnlyViolation';
}

export interface LiveTarget {
  /** Instance base URL, e.g. https://www7.v1host.com/MyInstance */
  baseUrl: string;
  token: string;
}

export interface LiveRequest {
  method?: 'GET' | 'POST';
  /** query.v1 body (one query or an array of queries); POST only. */
  body?: unknown;
  accept?: string;
}

export type LiveFetch = (path: string, request?: LiveRequest) => Promise<Response>;

const READ_GET = /^(?:meta\.v1(?:\/|$)|rest-1\.v1\/(?:Data|Hist)\/[A-Za-z]+)/;

/** Throws ReadOnlyViolation unless (method, path) is a read the harness may send. Exported for tests. */
export function assertReadOnly(base: URL, url: URL, method: string): void {
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
    throw new ReadOnlyViolation('request outside the instance base URL');
  }
  if (url.searchParams.has('op')) throw new ReadOnlyViolation('operations (op=) are writes');
  const rel = url.pathname.slice(base.pathname.length);
  if (method === 'GET' && READ_GET.test(rel)) return;
  if (method === 'POST' && rel === 'query.v1') return;
  throw new ReadOnlyViolation(`${method} ${rel || '/'} is not an allowed read`);
}

export function readOnlyFetch(target: LiveTarget, fetchImpl: typeof fetch = fetch): LiveFetch {
  const base = new URL(target.baseUrl.endsWith('/') ? target.baseUrl : `${target.baseUrl}/`);
  if (base.protocol !== 'https:') throw new ReadOnlyViolation('the live tenant must be reached over HTTPS');
  return async (path, request = {}) => {
    const method = request.method ?? 'GET';
    const url = new URL(path.replace(/^\//, ''), base);
    assertReadOnly(base, url, method);
    const headers: Record<string, string> = {
      authorization: `Bearer ${target.token}`,
      accept: request.accept ?? 'application/json',
    };
    if (method === 'POST') headers['content-type'] = 'application/json';
    const res = await fetchImpl(url, {
      method,
      headers,
      redirect: 'manual',
      ...(method === 'POST' ? { body: JSON.stringify(request.body) } : {}),
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      throw new ReadOnlyViolation(`redirect (${res.status}) refused`);
    }
    return res;
  };
}
