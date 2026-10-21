// SPDX-License-Identifier: Apache-2.0
// P1-12: the production Agility client (packages/core) against the live tenant, still behind the P0-12 read-only
// guard. Every Request the client builds is checked by assertReadOnly before it is sent.
import type { FetchLike } from '../packages/core/src/index.ts';
import { assertReadOnly, type LiveTarget, ReadOnlyViolation } from './readonly-fetch.ts';

export function guardedFetch(target: LiveTarget, fetchImpl: typeof fetch = fetch): FetchLike {
  const base = new URL(target.baseUrl.endsWith('/') ? target.baseUrl : `${target.baseUrl}/`);
  if (base.protocol !== 'https:') throw new ReadOnlyViolation('the live tenant must be reached over HTTPS');
  return (request) => {
    assertReadOnly(base, new URL(request.url), request.method);
    if (request.redirect !== 'manual') throw new ReadOnlyViolation('the client must not follow redirects');
    return fetchImpl(request);
  };
}
