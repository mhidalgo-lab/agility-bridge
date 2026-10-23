// SPDX-License-Identifier: Apache-2.0
// Response headers of every admin panel page (P4-03, THREAT_MODEL T13). The HTTP app's edge keeps exactly this policy on
// HTML pages and replaces any other policy with its JSON-only `default-src 'none'`.

/**
 * Content Security Policy of every HTML page: nothing inline (no `unsafe-inline`, no nonces: the pages carry no inline
 * script or style at all), scripts and styles only from our own origin, forms only to our own origin, never framed, no
 * `<base>`, and Trusted Types so no script can feed strings to HTML sinks.
 */
export const UI_CSP: string = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "require-trusted-types-for 'script'",
].join('; ');

/**
 * The policy of the owner setup page only: the same, without `form-action`. The form posts to this server and is answered
 * with a redirect to the identity provider, and Chromium applies `form-action` to the redirects that follow a form post,
 * so `'self'` would stop the sign-in at the redirect (found by P4-01). Nothing else about the page is looser.
 */
export const UI_CSP_SETUP: string = UI_CSP.replace("form-action 'self'; ", '');

/** Whether a response's CSP is one of the panel's own (kept by the app's edge, replaced otherwise). Compared as a whole. */
export const isUiCsp = (value: string | null): boolean => value === UI_CSP || value === UI_CSP_SETUP;

/** Powerful features the admin never needs. */
export const PERMISSIONS_POLICY: string = [
  'accelerometer=()',
  'camera=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'payment=()',
  'usb=()',
].join(', ');

/**
 * Referrer policy of HTML pages. Not `no-referrer`: with it a browser sends `Origin: null` on every form POST (Fetch
 * spec), which the CSRF check rightly refuses, so no form would ever work (L-191). `same-origin` sends the real `Origin`
 * to this server and no referrer at all to anyone else.
 */
export const UI_REFERRER_POLICY = 'same-origin';

/**
 * Headers an HTML page sets itself (the edge adds `nosniff`, `X-Frame-Options`, HSTS, ...). `no-store` is set here too,
 * not only by the edge: pages carry CSRF tokens and must never be cached.
 */
export const UI_PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': UI_REFERRER_POLICY,
  'Content-Security-Policy': UI_CSP,
  'Cross-Origin-Opener-Policy': 'same-origin',
  // Every subresource is same-origin, so the strictest embedder policy costs nothing.
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Permissions-Policy': PERMISSIONS_POLICY,
});
