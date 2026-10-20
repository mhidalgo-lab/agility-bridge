// SPDX-License-Identifier: Apache-2.0
// P0-09 mock Agility upstream, a separate Worker behind a service binding so generating payloads is not billed to the
// measured Worker. Synthetic data only.
import { syntheticQueryResult, syntheticRestXml } from './hotpath.ts';

const cache = new Map<string, string>();

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    const size = Number(url.searchParams.get('size') ?? 10_000);
    const xml = url.searchParams.get('format') === 'xml';
    const key = `${xml ? 'x' : 'j'}${size}`;
    // Generated once per isolate: the payload is constant, not request data.
    let body = cache.get(key);
    if (body === undefined) {
      body = xml ? syntheticRestXml(size) : syntheticQueryResult(size);
      cache.set(key, body);
    }
    return new Response(body, { headers: { 'content-type': xml ? 'text/xml' : 'application/json' } });
  },
};
