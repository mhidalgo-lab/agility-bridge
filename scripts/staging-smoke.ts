// SPDX-License-Identifier: Apache-2.0
// Smoke checks of a deployed agility-bridge over HTTPS (P3-11): what anyone on the internet sees, without credentials —
// health and version with the security headers, the uniform 401, the admin API closed, unknown paths, a hostile
// Origin. With AB_SMOKE_TOKEN (a device token, never an argument) it also lists the tools of AB_SMOKE_WORKSPACE.
//   node scripts/staging-smoke.ts https://agility-bridge-staging.<subdomain>.workers.dev
import { fileURLToPath } from 'node:url';

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
};
const LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
/** Shaped like a device token, but not one (built here so no token-like literal sits in the repository). */
const MADE_UP_TOKEN = ['ab', 'live', '0'.repeat(43), '000000'].join('_');

function securityHeaders(res: Response, https: boolean): string[] {
  const missing: string[] = [];
  if (res.headers.get('x-content-type-options') !== 'nosniff') missing.push('x-content-type-options');
  if (res.headers.get('x-frame-options') !== 'DENY') missing.push('x-frame-options');
  if (!(res.headers.get('content-security-policy') ?? '').includes("default-src 'none'")) missing.push('csp');
  if (https && !(res.headers.get('strict-transport-security') ?? '').includes('max-age='))
    missing.push('hsts');
  return missing;
}

export async function smoke(
  base: string,
  fetchFn: Fetch = fetch,
  options: { token?: string; workspace?: string } = {},
): Promise<Check[]> {
  const url = new URL(base);
  const https = url.protocol === 'https:';
  const at = (path: string) => `${url.origin}${path}`;
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const health = await fetchFn(at('/health'));
  const healthBody = await health.text();
  const missing = securityHeaders(health, https);
  check(
    'GET /health answers {"status":"ok"} with the security headers',
    health.status === 200 && healthBody === '{"status":"ok"}' && missing.length === 0,
    `${health.status} ${healthBody.slice(0, 60)} missing: ${missing.join(',') || 'none'}`,
  );
  const version = await fetchFn(at('/version'));
  const versionBody = (await version.json().catch(() => null)) as { version?: unknown } | null;
  check(
    'GET /version answers a version',
    version.status === 200 && typeof versionBody?.version === 'string',
    `${version.status}`,
  );

  const anonymous = await fetchFn(at('/w/smoke-test/mcp'), {
    method: 'POST',
    headers: MCP_HEADERS,
    body: LIST,
  });
  const anonymousBody = await anonymous.text();
  check(
    'MCP without a token: 401, Bearer challenge, one body, security headers',
    anonymous.status === 401 &&
      anonymous.headers.get('www-authenticate') === 'Bearer' &&
      anonymousBody === '{"error":"unauthorized"}' &&
      securityHeaders(anonymous, https).length === 0,
    `${anonymous.status} ${anonymousBody.slice(0, 60)}`,
  );
  const forged = await fetchFn(at('/w/smoke-test/mcp'), {
    method: 'POST',
    headers: {
      ...MCP_HEADERS,
      authorization: `Bearer ${MADE_UP_TOKEN}`,
    },
    body: LIST,
  });
  const forgedBody = await forged.text();
  check(
    'MCP with a made-up token: the same 401',
    forged.status === 401 && forgedBody === anonymousBody,
    `${forged.status}`,
  );

  const admin = await fetchFn(at('/api/admin/v1/users'));
  check(
    'Admin API without a token: 401 (or 404 when it is off)',
    admin.status === 401 || admin.status === 404,
    `${admin.status}`,
  );
  const unknown = await fetchFn(at('/definitely-not-a-route'));
  check(
    'Unknown path: 404 with the security headers',
    unknown.status === 404 && securityHeaders(unknown, https).length === 0,
    `${unknown.status}`,
  );
  const origin = await fetchFn(at('/w/smoke-test/mcp'), {
    method: 'POST',
    headers: { ...MCP_HEADERS, origin: 'https://evil.example' },
    body: LIST,
  });
  check('A hostile browser Origin: 403 (DNS rebinding, T24)', origin.status === 403, `${origin.status}`);

  if (options.token !== undefined && options.workspace !== undefined) {
    const listed = await fetchFn(at(`/w/${encodeURIComponent(options.workspace)}/mcp`), {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: `Bearer ${options.token}` },
      body: LIST,
    });
    const text = await listed.text();
    const tools = (text.match(/"name":"[a-z_]+"/g) ?? []).length;
    check(
      'tools/list with the device token',
      listed.status === 200 && tools > 0,
      `${listed.status} ${tools} tools`,
    );
  }
  return checks;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.argv[2];
  if (base === undefined) {
    console.error(
      'usage: node scripts/staging-smoke.ts <https://deployment> (AB_SMOKE_TOKEN, AB_SMOKE_WORKSPACE optional)',
    );
    process.exit(2);
  }
  const token = process.env['AB_SMOKE_TOKEN'];
  const workspace = process.env['AB_SMOKE_WORKSPACE'];
  const checks = await smoke(base, fetch, {
    ...(token ? { token } : {}),
    ...(workspace ? { workspace } : {}),
  });
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}
