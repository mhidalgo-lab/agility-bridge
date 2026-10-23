// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Headers of every panel page (P4-03, THREAT_MODEL T13). The policy is spelled out here, once, as a literal: a test that
// compared the header to the constant it was built from could never fail.
import { describe, expect, it } from 'vitest';
import { isUiCsp, PERMISSIONS_POLICY, UI_CSP, UI_CSP_SETUP, UI_PAGE_HEADERS } from '../src/headers.ts';
import { errorPage, htmlResponse, setupPageResponse } from '../src/pages.tsx';

const POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'";

describe('the content security policy', () => {
  it('is exactly this', () => {
    expect(UI_CSP).toBe(POLICY);
  });

  it('allows nothing inline or dynamic and nothing from another origin', () => {
    expect(UI_CSP).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|nonce-|strict-dynamic/);
    expect(UI_CSP).not.toMatch(/\*|https?:|data:|blob:/);
    const directives = Object.fromEntries(
      UI_CSP.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]),
    );
    expect(directives['default-src']).toEqual(["'none'"]);
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
    expect(directives['base-uri']).toEqual(["'none'"]);
    for (const d of ['script-src', 'style-src', 'img-src', 'connect-src', 'form-action'])
      expect(directives[d], d).toEqual(["'self'"]);
  });

  it('is only ever loosened for the owner setup page, by dropping form-action and nothing else', () => {
    expect(UI_CSP_SETUP).toBe(POLICY.replace("form-action 'self'; ", ''));
    expect(isUiCsp(UI_CSP)).toBe(true);
    expect(isUiCsp(UI_CSP_SETUP)).toBe(true);
    expect(isUiCsp(null)).toBe(false);
    expect(isUiCsp(`${POLICY}; script-src 'unsafe-inline'`)).toBe(false);
    expect(isUiCsp(POLICY.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"))).toBe(false);
    expect(isUiCsp("default-src 'none'; frame-ancestors 'none'")).toBe(false);
    expect(isUiCsp('')).toBe(false);
  });
});

describe('page headers', () => {
  it('are exactly this set', () => {
    expect({ ...UI_PAGE_HEADERS }).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': POLICY,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Permissions-Policy': PERMISSIONS_POLICY,
    });
    expect(PERMISSIONS_POLICY).toBe(
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
    );
  });

  it('every kind of page response carries them (error, setup and extra headers included)', () => {
    const responses = [
      errorPage(404, 'r'),
      errorPage(500, undefined),
      htmlResponse(<p>x</p>),
      setupPageResponse([]),
    ];
    for (const res of responses) {
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('same-origin');
      expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(isUiCsp(res.headers.get('content-security-policy'))).toBe(true);
    }
  });

  it('an extra header replaces a default instead of adding a second policy; cookies repeat', () => {
    const res = htmlResponse(<p>x</p>, 200, [
      ['Content-Security-Policy', "default-src 'none'"],
      ['Set-Cookie', 'a=1'],
      ['Set-Cookie', 'b=2'],
    ]);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });
});
