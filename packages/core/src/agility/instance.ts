// SPDX-License-Identifier: Apache-2.0
import { AbError, ErrorCode } from '../errors.ts';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function invalid(reason: string): AbError {
  return new AbError(ErrorCode.InputInvalid, `The Agility instance URL ${reason}.`, {
    hint: 'Use the address you open Agility at, e.g. https://www7.v1host.com/YourInstance (no login page, no query).',
  });
}

/**
 * The canonical form of an instance URL, fixed at configuration time (L-054, L-055): HTTPS (plain HTTP only for
 * loopback tests), no user info, query or fragment, the path kept, no trailing slash.
 */
export function canonicalInstanceUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw invalid('is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    throw invalid('must use https://');
  }
  if (url.username !== '' || url.password !== '') throw invalid('must not contain a user name or password');
  if (url.search !== '' || url.hash !== '' || /[?#]/.test(input))
    throw invalid('must not contain a query or fragment');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
