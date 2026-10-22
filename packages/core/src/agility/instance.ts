// SPDX-License-Identifier: Apache-2.0
import { AbError, ErrorCode } from '../errors.ts';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function invalid(reason: string): AbError {
  return new AbError(ErrorCode.InputInvalid, `The Agility instance URL ${reason}.`, {
    hint: 'Use the address you open Agility at, e.g. https://www7.v1host.com/YourInstance (no login page, no query).',
  });
}

export interface InstanceUrlOptions {
  /**
   * Accept `http://localhost`, `http://127.0.0.1` and `http://[::1]` (default true, for local tests and the stdio
   * mode). Servers pass false unless `AB_ALLOW_HTTP_INSTANCES=on` (P2-19).
   */
  readonly httpLoopback?: boolean;
}

/**
 * The canonical form of an instance URL, fixed at configuration time (L-054, L-055): HTTPS (plain HTTP only for
 * loopback tests), no user info, query or fragment, the path kept, no trailing slash.
 */
export function canonicalInstanceUrl(input: string, options: InstanceUrlOptions = {}): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw invalid('is not a valid URL');
  }
  const httpOk =
    (options.httpLoopback ?? true) && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !httpOk) throw invalid('must use https://');
  if (url.username !== '' || url.password !== '') throw invalid('must not contain a user name or password');
  if (url.search !== '' || url.hash !== '' || /[?#]/.test(input))
    throw invalid('must not contain a query or fragment');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The kind of an IP address literal, for refusing non-public instance addresses (P2-19, THREAT_MODEL A9). */
export type AddressClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'unspecified'
  | 'reserved'
  | 'invalid';

function ipv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function ipv4Class([a, b, c]: number[] = []): AddressClass {
  if (a === undefined || b === undefined) return 'invalid';
  // IETF protocol assignments, benchmarking, and the three documentation ranges (P3-11 review).
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'reserved';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved';
  if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return 'reserved';
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // carrier-grade NAT
  if (a === 169 && b === 254) return 'link-local'; // also the cloud metadata address 169.254.169.254
  if (a >= 224) return 'reserved'; // multicast and reserved
  return 'public';
}

/** Expands an IPv6 literal to 8 groups, or null. */
function ipv6(text: string): number[] | null {
  const raw = text.replace(/^\[|\]$/g, '').toLowerCase();
  if (!raw.includes(':') || raw.includes('%')) return null;
  let head = raw;
  let v4: number[] | null = null;
  const lastColon = raw.lastIndexOf(':');
  if (raw.slice(lastColon + 1).includes('.')) {
    v4 = ipv4(raw.slice(lastColon + 1));
    if (v4 === null) return null;
    head = `${raw.slice(0, lastColon + 1)}${((v4[0] as number) * 256 + (v4[1] as number)).toString(16)}:${(
      (v4[2] as number) * 256 + (v4[3] as number)
    ).toString(16)}`;
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] === '' ? [] : (halves[0] as string).split(':');
  const right = halves.length === 1 || halves[1] === '' ? [] : (halves[1] as string).split(':');
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0) return null;
  const groups = [...left, ...Array<string>(fill).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => Number.parseInt(g, 16));
}

/** Classifies an IPv4 or IPv6 literal (brackets allowed); IPv4-mapped IPv6 is classified as IPv4. */
export function addressClass(ip: string): AddressClass {
  const v4 = ipv4(ip);
  if (v4 !== null) return ipv4Class(v4);
  const g = ipv6(ip);
  if (g === null) return 'invalid';
  const [g0 = 0, , , , , g5 = 0, g6 = 0, g7 = 0] = g;
  if (g.every((x) => x === 0)) return 'unspecified';
  if (g.slice(0, 7).every((x) => x === 0) && g7 === 1) return 'loopback';
  const embedded = (hi: number, lo: number) => ipv4Class([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  // IPv4 inside IPv6 counts as that IPv4 address (P3-11 review): mapped ::ffff:a.b.c.d, SIIT ::ffff:0:a.b.c.d,
  // IPv4-compatible ::a.b.c.d, NAT64 64:ff9b::a.b.c.d, and 6to4 2002:aabb:ccdd::.
  if (g.slice(0, 5).every((x) => x === 0) && g5 === 0xffff) return embedded(g6, g7);
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g5 === 0) return embedded(g6, g7);
  if (g.slice(0, 6).every((x) => x === 0)) return embedded(g6, g7);
  if (g0 === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g6, g7);
  if (g0 === 0x2002) return embedded(g[1] ?? 0, g[2] ?? 0);
  if ((g0 & 0xffc0) === 0xfec0) return 'private'; // fec0::/10 site-local (deprecated)
  if (g0 === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return 'reserved'; // 100::/64 discard
  if ((g0 & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return 'link-local';
  if ((g0 & 0xff00) === 0xff00) return 'reserved'; // multicast
  if (g0 === 0x2001 && g[1] === 0x0db8) return 'reserved'; // documentation
  return 'public';
}
