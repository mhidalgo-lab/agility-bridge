// SPDX-License-Identifier: Apache-2.0
// Nothing is exposed that was not meant to be (P9-06, ASVS 5.0 V13.4): no TRACE, no source-control metadata, no
// listings, no debug or documentation endpoints, and every answer carries the fixed security headers.
import { describe, expect, it } from 'vitest';
import { ORIGIN, world } from './helpers/world.ts';

const PROBES = [
  '/.git/config',
  '/.git/HEAD',
  '/.svn/entries',
  '/.env',
  '/package.json',
  '/node_modules/',
  '/debug',
  '/metrics',
  '/swagger.json',
  '/openapi.json',
  '/docs',
  '/admin/../.env',
  '/%2e%2e/%2e%2e/etc/passwd',
  '/w/team-a/',
  '/w/team-a/mcp/../../.git/config',
];

describe('unintended exposure (V13.4)', () => {
  it('answers unusual methods without echoing the request', async () => {
    const w = await world();
    for (const method of ['PROPFIND', 'PATCH', 'DELETE', 'OPTIONS']) {
      const res = await w.app.fetch(
        new Request(`${ORIGIN}/w/team-a/mcp`, {
          method: method as 'GET',
          headers: { 'x-probe': 'echo-me-not' },
        }),
      );
      expect([204, 401, 404, 405], method).toContain(res.status);
      const body = await res.text();
      expect(body, method).not.toContain('echo-me-not');
      expect(res.headers.get('access-control-allow-origin'), method).toBeNull();
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('serves nothing for source-control, environment, debug or documentation paths, with the fixed headers', async () => {
    const w = await world();
    for (const path of PROBES) {
      const res = await w.app.fetch(new Request(`${ORIGIN}${path}`));
      expect([400, 401, 403, 404, 405], path).toContain(res.status);
      const body = await res.text();
      expect(body, path).not.toMatch(
        /\[core\]|repositoryformatversion|root:|"dependencies"|<title>Index of/i,
      );
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(res.headers.get('cache-control'), path).toBe('no-store');
      expect(res.headers.get('content-security-policy'), path).toContain("default-src 'none'");
    }
  });
});
