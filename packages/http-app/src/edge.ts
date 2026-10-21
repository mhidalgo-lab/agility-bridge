// SPDX-License-Identifier: Apache-2.0
// Edge protections for every response (ARCHITECTURE §5 step 1): security headers derived from the public URL (L-083),
// Host and Origin allowlists against DNS rebinding (L-082, THREAT_MODEL T24), CORS only when configured.

export interface EdgeOptions {
  /** `AB_PUBLIC_URL`: the origin clients use. HTTPS turns HSTS on and adds its host to the allowed hosts. */
  readonly publicUrl?: string;
  /** `AB_ALLOWED_HOSTS`: extra `Host` values (name or name:port). Loopback names are always allowed. */
  readonly allowedHosts?: readonly string[];
  /** `AB_ALLOWED_ORIGINS`: browser origins allowed to call the API (and given CORS headers). */
  readonly allowedOrigins?: readonly string[];
}

export interface Edge {
  /** Headers every response carries, errors and 404s included. */
  readonly securityHeaders: Readonly<Record<string, string>>;
  hostAllowed(host: string | null | undefined): boolean;
  /** `null`/absent Origin (non-browser clients) is fine; `Origin: null` and unknown origins are refused. */
  originAllowed(origin: string | null | undefined): boolean;
  /** CORS headers for an allowed browser origin, or none. */
  corsHeaders(origin: string | null | undefined): Record<string, string>;
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** A `Host` value: a DNS name or IPv4 address, or a bracketed IPv6 address, and an optional numeric port. */
const HOST = /^(?:([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)|(\[[0-9a-f:.]{2,45}\]))(?::([0-9]{1,5}))?$/;

/** Lower-cased host without a port (`[::1]:8787` → `[::1]`), or `null` when the value is not a well-formed host. */
function hostName(host: string): string | null {
  const m = HOST.exec(host.toLowerCase());
  if (m === null) return null;
  return (m[1] ?? m[2]) as string;
}

function canonicalOrigin(origin: string): string | null {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function createEdge(options: EdgeOptions): Edge {
  const publicUrl = options.publicUrl === undefined ? undefined : new URL(options.publicUrl);
  const hosts = new Set<string>(LOOPBACK);
  const exactHosts = new Set<string>();
  if (publicUrl !== undefined) exactHosts.add(publicUrl.host.toLowerCase());
  for (const h of options.allowedHosts ?? []) {
    const v = h.trim().toLowerCase();
    if (v.includes(':') && !v.startsWith('[')) exactHosts.add(v);
    else hosts.add(hostName(v) ?? v);
  }
  const origins = new Set<string>();
  if (publicUrl !== undefined) origins.add(publicUrl.origin);
  const corsOrigins = new Set<string>();
  for (const o of options.allowedOrigins ?? []) {
    const c = canonicalOrigin(o);
    if (c !== null) {
      origins.add(c);
      corsOrigins.add(c);
    }
  }

  const securityHeaders: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'no-store',
  };
  if (publicUrl?.protocol === 'https:') {
    securityHeaders['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  }

  return {
    securityHeaders: Object.freeze(securityHeaders),
    hostAllowed(host) {
      if (typeof host !== 'string' || host === '' || host.length > 300) return false;
      // Strict syntax first (P2-17 review L3): `localhost:x`, `localhost:8787, evil`, trailing junk are refused.
      const name = hostName(host);
      if (name === null) return false;
      const lower = host.toLowerCase();
      return exactHosts.has(lower) || hosts.has(name);
    },
    originAllowed(origin) {
      if (origin === undefined || origin === null) return true;
      const c = canonicalOrigin(origin);
      return c !== null && origins.has(c);
    },
    corsHeaders(origin) {
      const c = typeof origin === 'string' ? canonicalOrigin(origin) : null;
      if (c === null || !corsOrigins.has(c)) return {};
      return {
        'access-control-allow-origin': c,
        'access-control-allow-headers':
          'authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name, last-event-id',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-expose-headers': 'mcp-protocol-version, www-authenticate, retry-after, x-request-id',
        'access-control-max-age': '600',
        vary: 'Origin',
      };
    },
  };
}
