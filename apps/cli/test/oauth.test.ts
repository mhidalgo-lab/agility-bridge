// SPDX-License-Identifier: Apache-2.0
// The OAuth suite on Node with SQLite storage (P5-01): `agility-bridge serve` started as the CLI starts it, with OAuth
// on and the consent stand-in, called in process through its app (the issuer is the configured public URL, so no
// socket is needed), plus the settings checks of the shipped host and a scan of the database file itself.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accessServices, generateAdminToken, generateMasterKey, Keyring } from '@agility-bridge/auth';
import { CORE_TOOLS } from '@agility-bridge/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineOAuthAbuseSuite } from '../../../packages/http-app/test/oauth/abuse-suite.ts';
import { defineOAuthAdminSuite } from '../../../packages/http-app/test/oauth/admin-suite.ts';
import {
  type DocumentHostsShape,
  defineDocumentHostsSuite,
  defineOAuthClientSuite,
} from '../../../packages/http-app/test/oauth/clients-suite.ts';
import { testConsent } from '../../../packages/http-app/test/oauth/consent.ts';
import { createFakeDocuments } from '../../../packages/http-app/test/oauth/documents.ts';
import {
  type ActivityHostShape,
  defineDeviceActivitySuite,
  defineOAuthSuite,
  defineOAuthWriteScopeSuite,
  defineRefreshFamilySuite,
  type OAuthHost,
  type RefreshHostShape,
} from '../../../packages/http-app/test/oauth/suite.ts';
import { type FixtureAgility, startFixtureAgility } from '../../../scripts/fixture-agility.ts';
import { ConfigError } from '../src/config.ts';
import { loadServeConfig, startServe } from '../src/serve.ts';

const ORIGIN = 'http://127.0.0.1:8787';
let agility: FixtureAgility;
beforeAll(async () => {
  agility = await startFixtureAgility();
});
afterAll(() => agility.close());

async function sqliteHost(
  shape?: Partial<RefreshHostShape> & ActivityHostShape & Partial<DocumentHostsShape> & { writes?: boolean },
): Promise<OAuthHost> {
  const dir = mkdtempSync(join(tmpdir(), 'ab-oauth-'));
  const key = generateMasterKey(1);
  writeFileSync(join(dir, 'master.key'), key, { mode: 0o600 });
  const lines: string[] = [];
  const adminToken = generateAdminToken();
  const documents = createFakeDocuments();
  const running = await startServe(
    {
      AB_DATA_DIR: join(dir, 'data'),
      AB_MASTER_KEY_FILE: join(dir, 'master.key'),
      AB_PORT: '0',
      AB_PUBLIC_URL: ORIGIN,
      AB_OAUTH: 'on',
      AB_ADMIN_TOKEN: adminToken,
      ...(shape?.reuseWindowSeconds === undefined
        ? {}
        : { AB_OAUTH_REFRESH_REUSE_WINDOW: String(shape.reuseWindowSeconds) }),
      ...(shape?.idleTtlSeconds === undefined ? {} : { AB_OAUTH_IDLE_TTL: String(shape.idleTtlSeconds) }),
      ...(shape?.cimdHosts === undefined ? {} : { AB_OAUTH_CIMD_HOSTS: shape.cimdHosts.join(',') }),
      AB_ACCESS_CACHE_TTL: '0',
      ...(shape?.writes === true ? { AB_WRITE_TOOLS: 'on' } : {}),
      AB_ALLOW_HTTP_INSTANCES: 'on',
      AB_ENVIRONMENT: 'production',
      // The client address comes from the proxy header, so a test can be several addresses (P5-09).
      AB_TRUSTED_PROXY_HOPS: '1',
    },
    { sink: (l) => lines.push(l), oauthConsent: testConsent, clientMetadataFetch: documents.fetcher },
  );
  const svc = accessServices({
    storage: running.storage,
    keyring: await Keyring.create(key),
    tools: new Map(CORE_TOOLS.map((t) => [t.name, { kind: t.kind, group: t.group }])),
    instanceUrls: { httpLoopback: true },
  });
  const alice = await svc.users.create({ email: 'alice@example.test', role: 'member' });
  const bob = await svc.users.create({ email: 'bob@example.test', role: 'member' });
  const instance = await svc.instances.create({ label: 'Synthetic', baseUrl: agility.url });
  const credential = async (owner: string | null, token: string) => {
    const c = await svc.credentials.create({
      instanceId: instance.id,
      ownerUserId: owner,
      label: 'c',
      token,
    });
    await running.storage.credentials.update(c.id, { validationStatus: 'valid' });
    return c;
  };
  const aliceCred = await credential(alice.id, '1.AliceAgilityTokenNotRealAbCdEfGh0001');
  const bobCred = await credential(bob.id, '1.BobAgilityTokenNotRealAbCdEfGhIj0002');
  const shared = await credential(null, '1.SharedAgilityTokenNotRealAbCdEfGh0003');
  const wsA = await svc.workspaces.create({
    slug: 'team-a',
    name: 'Team A',
    instanceId: instance.id,
    allowedScopeIds: ['Scope:1001'],
  });
  const wsB = await svc.workspaces.create({
    slug: 'team-b',
    name: 'Team B',
    instanceId: instance.id,
    allowedScopeIds: ['Scope:1001'],
  });
  const grant = async (workspaceId: string, userId: string | null, credentialId: string) =>
    (
      await svc.grants.create({
        workspaceId,
        userId,
        credentialId,
        ...(userId === null ? { label: 'ci' } : {}),
      })
    ).record;
  const aliceGrantA = await grant(wsA.id, alice.id, aliceCred.id);
  const aliceGrantB = await grant(wsB.id, alice.id, aliceCred.id);
  const bobGrantB = await grant(wsB.id, bob.id, bobCred.id);
  const serviceGrantA = await grant(wsA.id, null, shared.id);
  const { token } = await svc.tokens.issue({ grantId: aliceGrantA.id, label: 'laptop' });
  return {
    origin: ORIGIN,
    documents,
    call: (url, init) => Promise.resolve(running.app.fetch(new Request(url, init))),
    storage: running.storage,
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
    logs: () => lines,
    // The database as bytes (and its write-ahead log): a copy of it must hold no bearer value either.
    rawDatabase: () =>
      [running.storage.path, `${running.storage.path}-wal`]
        .map((p) => {
          try {
            return readFileSync(p).toString('latin1');
          } catch {
            return '';
          }
        })
        .join('\n'),
    adminApi: (method, path, body) =>
      Promise.resolve(
        running.app.fetch(
          new Request(`${ORIGIN}/api/admin/v1${path}`, {
            method,
            headers: {
              authorization: `Bearer ${adminToken}`,
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        ),
      ),
    address: (ip) => ({ 'x-forwarded-for': ip }),
    // No `advance`: the SQLite storage reads its clock when it opens, so a mocked clock cannot expire its rows.
    close: async () => {
      await running.close();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        // Windows may keep the database locked a moment longer (L-104).
      }
    },
  };
}

defineOAuthSuite('SQLite storage (agility-bridge serve)', () => sqliteHost());
defineOAuthWriteScopeSuite('SQLite storage (agility-bridge serve)', (shape) => sqliteHost(shape));
defineRefreshFamilySuite('SQLite storage (agility-bridge serve)', sqliteHost);
defineDeviceActivitySuite('SQLite storage (agility-bridge serve)', sqliteHost);
defineOAuthClientSuite('SQLite storage (agility-bridge serve)', sqliteHost);
defineDocumentHostsSuite('SQLite storage (agility-bridge serve)', sqliteHost);
defineOAuthAdminSuite('SQLite storage (agility-bridge serve)', sqliteHost);
defineOAuthAbuseSuite('SQLite storage (agility-bridge serve)', sqliteHost);

describe('OAuth settings on the shipped host', () => {
  it('is off by default, and AB_OAUTH=on needs sign-in for the built-in consent screen (P5-04)', () => {
    expect(loadServeConfig({ AB_DATA_DIR: '/d' }).oauth).toBeUndefined();
    expect(() => loadServeConfig({ AB_OAUTH: 'on', AB_PUBLIC_URL: ORIGIN })).toThrow(/needs sign-in/);
    // With a sign-in provider the built-in screen is used: no stand-in needed.
    expect(
      loadServeConfig({
        AB_OAUTH: 'on',
        AB_PUBLIC_URL: ORIGIN,
        AB_OIDC_ISSUER: 'https://login.example.test',
        AB_OIDC_CLIENT_ID: 'client',
        AB_OIDC_CLIENT_SECRET: 'not-a-real-secret-value',
      }).oauth,
    ).toEqual({});
    expect(loadServeConfig({ AB_OAUTH: 'on', AB_PUBLIC_URL: ORIGIN }, { oauthConsent: true }).oauth).toEqual(
      {},
    );
    expect(
      loadServeConfig(
        {
          AB_OAUTH: 'on',
          AB_PUBLIC_URL: ORIGIN,
          AB_OAUTH_ACCESS_TTL: '30m',
          AB_OAUTH_REFRESH_TTL: '7d',
          AB_OAUTH_REFRESH_REUSE_WINDOW: '10',
        },
        { oauthConsent: true },
      ).oauth,
    ).toEqual({
      accessTokenTtlSeconds: 1800,
      refreshTokenTtlSeconds: 604_800,
      refreshReuseWindowSeconds: 10,
    });
  });

  it('checks the values, and needs AB_PUBLIC_URL (the issuer)', () => {
    const on = { AB_OAUTH: 'on', AB_PUBLIC_URL: ORIGIN };
    const features = { oauthConsent: true };
    for (const bad of [
      { AB_OAUTH: 'yes' },
      { AB_OAUTH: 'on' },
      { ...on, AB_OAUTH_ACCESS_TTL: '10s' },
      { ...on, AB_OAUTH_ACCESS_TTL: '2d' },
      { ...on, AB_OAUTH_REFRESH_TTL: '30m' },
      { ...on, AB_OAUTH_REFRESH_TTL: '400d' },
      { ...on, AB_OAUTH_REFRESH_TTL: 'soon' },
      { ...on, AB_OAUTH_REFRESH_REUSE_WINDOW: '121' },
      { ...on, AB_OAUTH_REFRESH_REUSE_WINDOW: 'never' },
      { ...on, AB_OAUTH_ACCESS_TTL: '12h', AB_OAUTH_REFRESH_TTL: '2h' },
    ]) {
      expect(() => loadServeConfig(bad, features), JSON.stringify(bad)).toThrow(ConfigError);
    }
    // Values are checked even when OAuth is off, so a typo does not wait for the day it is switched on.
    expect(() => loadServeConfig({ AB_OAUTH_ACCESS_TTL: '1s' })).toThrow(ConfigError);
  });

  it('refuses to start with AB_OAUTH=on and no sign-in, before opening any storage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-oauth-off-'));
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'master.key'), generateMasterKey(1), { mode: 0o600 });
    try {
      await expect(
        startServe({
          AB_DATA_DIR: join(dir, 'data'),
          AB_MASTER_KEY_FILE: join(dir, 'master.key'),
          AB_PORT: '0',
          AB_PUBLIC_URL: ORIGIN,
          AB_OAUTH: 'on',
        }),
      ).rejects.toThrow(/needs sign-in/);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
