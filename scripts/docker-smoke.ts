// SPDX-License-Identifier: Apache-2.0
// Smoke test of the Docker image (P2-11): run it non-root with a read-only root filesystem against the synthetic Agility,
// set up a workspace through the admin API, call a tool over MCP, and check the refusals and the healthcheck. The
// synthetic Agility runs in a second container sharing the server's network namespace, so it is on the server's
// loopback (instance URLs are HTTPS or loopback) on every Docker host, Docker Desktop included.
//   node --conditions=source scripts/docker-smoke.ts agility-bridge:local
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateAdminToken, generateMasterKey } from '../packages/auth/src/index.ts';

const image = process.argv[2] ?? 'agility-bridge:local';
const name = `ab-smoke-${process.pid}`;
const port = 18787;
const base = `http://127.0.0.1:${port}`;
const repo = fileURLToPath(new URL('..', import.meta.url));
const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205';
const agility = { url: 'http://127.0.0.1:18788/SyntheticInstance' };

function docker(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('docker', args, { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`smoke: ${what}`);
  console.error(`✓ ${what}`);
}

async function json(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // SSE or plain text
  }
  return { status: res.status, body: parsed as Record<string, unknown>, text };
}

const adminToken = generateAdminToken();
try {
  // Secrets reach the container by variable name only, never in argv (docker -e NAME reads them from this process).
  const run = (line: string) => line.split(' ');
  docker(
    [
      ...run(`run -d --name ${name} -p 127.0.0.1:${port}:8787 --read-only --tmpfs /tmp`),
      ...run('--health-interval 2s --health-start-period 2s'),
      ...run('-e AB_MASTER_KEY -e AB_ADMIN_TOKEN -e AB_ENVIRONMENT=test'),
      ...run(`-v ${name}:/data ${image}`),
    ],
    { AB_MASTER_KEY: generateMasterKey(1), AB_ADMIN_TOKEN: adminToken },
  );
  // The synthetic Agility on the server's own loopback (a second container in its network namespace).
  docker([
    ...run(`run -d --name ${name}-agility --network container:${name} -w /src`),
    '-v',
    `${repo}:/src:ro`,
    ...run(`${NODE_IMAGE} node --conditions=source scripts/fixture-agility.ts 18788`),
  ]);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      up = (await fetch(`${base}/health`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  check(up, 'the server answers /health');
  const inspect = JSON.parse(docker(['inspect', name]))[0];
  check(inspect.Config.User === '65532:65532', 'runs as the non-root user 65532');
  check(inspect.HostConfig.ReadonlyRootfs === true, 'runs with a read-only root filesystem');

  // The synthetic Agility starts in parallel: retry while the origin probe cannot reach it yet (502).
  const addInstance = () =>
    json('POST', '/api/admin/v1/instances', adminToken, { label: 'Synthetic', baseUrl: agility.url });
  let instance = await addInstance();
  for (let i = 0; i < 30 && instance.status === 502; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    instance = await addInstance();
  }
  check(instance.status === 201, `instance created after the origin probe (${instance.status})`);
  const cred = await json('POST', '/api/admin/v1/credentials', adminToken, {
    instanceId: instance.body['id'],
    ownerUserId: null,
    label: 'service',
    token: 'synthetic-token-any-value-works',
  });
  check(cred.body['validationStatus'] === 'valid', 'credential validated against Agility');
  const ws = await json('POST', '/api/admin/v1/workspaces', adminToken, {
    slug: 'smoke',
    name: 'Smoke',
    instanceId: instance.body['id'],
    allowedScopeIds: ['Scope:1001'],
    defaultCredentialId: cred.body['id'],
  });
  const grant = await json('POST', '/api/admin/v1/grants', adminToken, {
    workspaceId: ws.body['id'],
    userId: null,
    label: 'smoke',
  });
  const issued = await json(
    'POST',
    `/api/admin/v1/grants/${(grant.body['record'] as { id: string }).id}/tokens`,
    adminToken,
    {
      label: 'smoke',
    },
  );
  const device = String(issued.body['token']);
  check(device.startsWith('ab_test_'), 'device token issued (ab_test_ on a test deployment)');

  const call = (token: string | null, slug = 'smoke') =>
    json('POST', `/w/${slug}/mcp`, token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_assets', arguments: { assets: ['B-01001'] } },
    });
  const ok = await call(device);
  check(
    ok.status === 200 && ok.text.includes('Synthetic sign-in page'),
    'a tool call reads the synthetic Agility',
  );
  check((await call(null)).status === 401, 'no token: 401');
  check((await call(device, 'other')).status === 401, 'another workspace: 401');
  check(
    (await json('GET', '/api/admin/v1/users', null)).status === 401,
    'admin API without the admin token: 401',
  );

  let healthy = false;
  for (let i = 0; i < 30 && !healthy; i++) {
    healthy = docker(['inspect', '-f', '{{.State.Health.Status}}', name]) === 'healthy';
    if (!healthy) await new Promise((r) => setTimeout(r, 1000));
  }
  check(healthy, 'the container healthcheck reports healthy');
  const logs = docker(['logs', name]);
  check(!logs.includes(adminToken) && !logs.includes(device), 'no token in the container logs');
  console.error('docker smoke test passed');
} catch (error) {
  try {
    console.error(docker(['logs', name]));
  } catch {
    // no container
  }
  throw error;
} finally {
  for (const args of [
    ['rm', '-f', `${name}-agility`],
    ['rm', '-f', name],
    ['volume', 'rm', '-f', name],
  ]) {
    try {
      docker(args);
    } catch {
      // already gone
    }
  }
}
