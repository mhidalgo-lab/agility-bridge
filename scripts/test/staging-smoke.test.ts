// SPDX-License-Identifier: Apache-2.0
// The staging smoke checks (P3-11) pass on a well-behaved deployment and fail when a control is missing.
import { describe, expect, it } from 'vitest';
import { smoke } from '../staging-smoke.ts';

const SECURE = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'content-type': 'application/json',
};

function deployment(over: { hsts?: boolean; leaky401?: boolean } = {}) {
  const headers = { ...SECURE } as Record<string, string>;
  if (over.hsts === false) delete headers['strict-transport-security'];
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(input).pathname;
    const h = new Headers(init?.headers);
    if (path === '/health') return new Response('{"status":"ok"}', { headers });
    if (path === '/version') return new Response('{"version":"0.2.0"}', { headers });
    if (path.startsWith('/w/')) {
      if (h.get('origin') !== null) return new Response('{"error":"forbidden"}', { status: 403, headers });
      if (h.get('authorization') === 'Bearer good')
        return new Response('{"tools":[{"name":"whoami"}]}', { headers });
      const body =
        over.leaky401 === true && h.get('authorization') !== null
          ? '{"error":"token revoked"}'
          : '{"error":"unauthorized"}';
      return new Response(body, { status: 401, headers: { ...headers, 'www-authenticate': 'Bearer' } });
    }
    if (path.startsWith('/api/admin/')) return new Response('{}', { status: 401, headers });
    return new Response('{}', { status: 404, headers });
  };
}

describe('staging smoke', () => {
  it('passes a well-behaved deployment, with the optional device-token check', async () => {
    const checks = await smoke('https://x.example', deployment(), { token: 'good', workspace: 'w' });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks).toHaveLength(8);
  });

  it('fails without HSTS on HTTPS, and when a made-up token gets a different 401', async () => {
    const noHsts = await smoke('https://x.example', deployment({ hsts: false }));
    expect(noHsts.find((c) => c.name.startsWith('GET /health'))?.ok).toBe(false);
    const leaky = await smoke('https://x.example', deployment({ leaky401: true }));
    expect(leaky.find((c) => c.name.startsWith('MCP with a made-up token'))?.ok).toBe(false);
  });
});
