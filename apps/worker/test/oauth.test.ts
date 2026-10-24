// SPDX-License-Identifier: Apache-2.0
// The OAuth suite on workerd with D1 (P5-01, L-086, L-096): the Worker bundled the way CI bundles it, with the consent
// stand-in of the tests in place of the screen P5-04 adds, run in Miniflare on a local D1. The world is built from Node
// on the Worker's own database with the same master key, as in the authorization matrix (P3-06). State is in D1 on
// every request (the Worker keeps nothing between requests), so a code approved by one request is redeemed by another.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessServices, generateMasterKey, Keyring } from '@agility-bridge/auth';
import { CORE_TOOLS } from '@agility-bridge/core';
import { createD1Driver, type D1Database, openSqlStorage } from '@agility-bridge/storage';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineOAuthSuite, type OAuthHost } from '../../../packages/http-app/test/oauth/suite.ts';
import { type FixtureAgility, startFixtureAgility } from '../../../scripts/fixture-agility.ts';
import { BootError, boot } from '../src/boot.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'dist', 'oauth-test', 'oauth-entry.js');
const ORIGIN = 'http://127.0.0.1';

let agility: FixtureAgility;
const running: Miniflare[] = [];
beforeAll(async () => {
  // The Worker plus the consent stand-in (test/fixtures/oauth-entry.ts), bundled by wrangler like the real one.
  execFileSync(
    join(ROOT, 'node_modules', '.bin', 'wrangler'),
    ['deploy', '--dry-run', '--outdir', 'dist/oauth-test', 'test/fixtures/oauth-entry.ts'],
    { cwd: ROOT, stdio: 'ignore' },
  );
  agility = await startFixtureAgility();
});
afterAll(() => agility.close());
afterEach(async () => {
  await Promise.all(running.splice(0).map((mf) => mf.dispose()));
});

async function workerHost(): Promise<OAuthHost> {
  const key = generateMasterKey(1);
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: SCRIPT,
      compatibilityDate: '2026-09-26',
      d1Databases: ['DB'],
      bindings: {
        AB_ENVIRONMENT: 'test',
        AB_MASTER_KEY: key,
        AB_ALLOW_HTTP_INSTANCES: 'on',
        AB_PUBLIC_URL: ORIGIN,
        AB_OAUTH: 'on',
        AB_ACCESS_CACHE_TTL: '0',
        // One Worker serves a whole test (dozens of requests from one address); limits have their own tests.
        AB_RATE_LIMIT_AUTH_FAILURES: '1000',
      },
    }),
  );
  running.push(mf);
  const storage = await openSqlStorage(
    createD1Driver((await mf.getD1Database('DB')) as unknown as D1Database),
  );
  const svc = accessServices({
    storage,
    keyring: await Keyring.create(key),
    tools: new Map(CORE_TOOLS.map((t) => [t.name, { kind: t.kind, group: t.group }])),
    environment: 'test',
    instanceUrls: { httpLoopback: true },
  });
  const alice = await svc.users.create({ email: 'alice@example.test', role: 'member' });
  const bob = await svc.users.create({ email: 'bob@example.test', role: 'member' });
  const instance = await svc.instances.create({ label: 'Synthetic', baseUrl: agility.url });
  const credential = async (owner: string | null) => {
    const c = await svc.credentials.create({
      instanceId: instance.id,
      ownerUserId: owner,
      label: owner ?? 'shared',
      token: 'synthetic-token-any-value',
    });
    await storage.credentials.update(c.id, { validationStatus: 'valid' });
    return c.id;
  };
  const aliceCred = await credential(alice.id);
  const bobCred = await credential(bob.id);
  const sharedCred = await credential(null);
  const workspace = (slug: string, name: string) =>
    svc.workspaces.create({ slug, name, instanceId: instance.id, allowedScopeIds: ['Scope:1001'] });
  const wsA = await workspace('team-a', 'Team A');
  const wsB = await workspace('team-b', 'Team B');
  const grant = async (workspaceId: string, userId: string | null, credentialId: string) =>
    (
      await svc.grants.create({
        workspaceId,
        userId,
        credentialId,
        ...(userId === null ? { label: 'ci' } : {}),
      })
    ).record;
  const aliceGrantA = await grant(wsA.id, alice.id, aliceCred);
  const aliceGrantB = await grant(wsB.id, alice.id, aliceCred);
  const bobGrantB = await grant(wsB.id, bob.id, bobCred);
  const serviceGrantA = await grant(wsA.id, null, sharedCred);
  const { token } = await svc.tokens.issue({ grantId: aliceGrantA.id, label: 'laptop' });
  return {
    origin: ORIGIN,
    call: async (url, init) =>
      (await mf.dispatchFetch(url, {
        ...init,
        headers: { 'cf-connecting-ip': '203.0.113.9', ...(init?.headers as Record<string, string>) },
      } as never)) as unknown as Response,
    storage,
    ids: {
      alice: alice.id,
      bob: bob.id,
      workspaceA: wsA.id,
      workspaceB: wsB.id,
      aliceGrantA: aliceGrantA.id,
      aliceGrantB: aliceGrantB.id,
      bobGrantB: bobGrantB.id,
      serviceGrantA: serviceGrantA.id,
      aliceDeviceTokenA: token,
    },
    agilityRequests: () => agility.requests(),
    // The Worker's console is not captured here; the redaction corpus and the Node suites cover the log lines.
    logs: () => [],
    close: async () => {
      await mf.dispose();
    },
  };
}

defineOAuthSuite('workerd with D1 (Worker)', workerHost);

describe('OAuth settings on the shipped Worker', () => {
  const base = {
    AB_MASTER_KEY: generateMasterKey(1),
    AB_PUBLIC_URL: ORIGIN,
    AB_OAUTH: 'on',
  };

  it('refuses AB_OAUTH=on until the consent screen exists, before touching storage (P5-04)', async () => {
    // No D1 binding is given: the settings are refused first.
    await expect(boot({ ...base } as never, '0.0.0-test')).rejects.toThrow(/consent screen/);
  });

  it('knows the OAuth variables, so a typo is still caught and the real names are not', async () => {
    await expect(
      boot({ ...base, AB_OAUTH: 'off', AB_OAUTH_TYPO: '1' } as never, '0.0.0-test'),
    ).rejects.toThrow(BootError);
    // With OAuth off the OAuth variables are accepted (and checked), and boot goes on to the missing D1 binding.
    await expect(
      boot({ AB_OAUTH: 'off', AB_OAUTH_ACCESS_TTL: '30m' } as never, '0.0.0-test'),
    ).rejects.toThrow(/D1 binding/);
  });
});
