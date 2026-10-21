// SPDX-License-Identifier: Apache-2.0
// Credential validation and the instance probe (P2-13, THREAT_MODEL A5, A9, A14).
import {
  CircuitBreakers,
  CredentialLimiters,
  MetadataService,
  silentLogger,
  webCryptoRandom,
} from '@agility-bridge/core';
import { createMemoryStorage, type Storage } from '@agility-bridge/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import snapshotJson from '../../core/test/fixtures/agility/meta-snapshot.json' with { type: 'json' };
import { FAKE_BASE_URL, FakeAgility, type FakeAgilityOptions } from '../../core/test/harness/index.ts';
import {
  accessServices,
  credentialValidator,
  generateMasterKey,
  Keyring,
  probeInstance,
  UpstreamCheckError,
  validateAgilityToken,
} from '../src/index.ts';
import { NOW, TOOLS } from './helpers/access.ts';

const TOKEN = '1.MemberTokenNotRealAbCdEfGhIjKl9876';
const ASSETS = {
  Member: [{ _oid: 'Member:20', Name: 'Ann Example', Username: 'ann', IsSelf: true, AssetState: 64 }],
  Scope: [
    { _oid: 'Scope:1001', Name: 'Mobile', AssetState: 64 },
    { _oid: 'Scope:1002', Name: 'Web', AssetState: 64 },
  ],
};

function services(options: FakeAgilityOptions = {}) {
  const sent: { url: string; auth: string | null }[] = [];
  const fake = new FakeAgility({
    meta: snapshotJson as unknown as Record<string, unknown>,
    assets: ASSETS,
    ...options,
    override: async (req, call) => {
      sent.push({ url: req.url, auth: req.headers.get('authorization') });
      return options.override?.(req, call);
    },
  });
  const host = {
    fetchFor: () => fake.fetch,
    limiters: new CredentialLimiters(),
    breakers: new CircuitBreakers(),
    metadata: new MetadataService(),
    logger: silentLogger,
    clock: { now: () => NOW },
    random: webCryptoRandom,
  };
  return { host, fake, sent };
}

const instance = { id: 'i-1', baseUrl: FAKE_BASE_URL, tls: null };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('validateAgilityToken', () => {
  it('a valid token: the member and every project it can see', async () => {
    const { host } = services();
    expect(await validateAgilityToken(host, instance, 'c-1', TOKEN)).toEqual({
      status: 'valid',
      memberOid: 'Member:20',
      memberName: 'Ann Example',
      memberUsername: 'ann',
      reachableScopeIds: ['Scope:1001', 'Scope:1002'],
    });
  });

  it('a revoked token is invalid, with a message about the token (not the address)', async () => {
    const { host } = services({ override: () => json(401, { error: 'Unauthorized' }) });
    const r = await validateAgilityToken(host, instance, 'c-1', TOKEN);
    expect(r).toMatchObject({ status: 'invalid', code: 'AB_AGILITY_AUTH' });
    expect(r.status !== 'valid' && r.message).toContain('revoked');
  });

  it('a wrong instance (a web page, or a redirect) is invalid, with a message about the address', async () => {
    for (const answer of [
      () => new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      () => new Response(null, { status: 302, headers: { location: 'https://login.example.test/' } }),
    ]) {
      const { host } = services({ override: answer });
      const r = await validateAgilityToken(host, instance, 'c-1', TOKEN);
      expect(r).toMatchObject({ status: 'invalid', code: 'AB_AGILITY_WRONG_INSTANCE' });
      expect(r.status !== 'valid' && r.message).toContain('address');
    }
  });

  it('an outage is "unavailable": nothing is concluded about the token', async () => {
    const { host } = services({ override: () => json(503, {}) });
    expect(await validateAgilityToken(host, instance, 'c-1', TOKEN)).toMatchObject({
      status: 'unavailable',
      code: 'AB_AGILITY_UNAVAILABLE',
    });
  });
});

describe('probeInstance', () => {
  it('accepts an origin whose public meta.v1 answers JSON, without sending any token', async () => {
    const { fake, sent } = services({
      override: (req) =>
        req.url.endsWith('meta.v1/Member')
          ? json(200, { Token: 'Member', Name: 'Member' }, { etag: '"26.2.1.abc"' })
          : undefined,
    });
    expect(await probeInstance(fake.fetch, FAKE_BASE_URL)).toEqual({ ok: true, fingerprint: '"26.2.1.abc"' });
    expect(sent).toEqual([{ url: `${FAKE_BASE_URL}/meta.v1/Member`, auth: null }]);
  });

  it('refuses redirects, web pages, other JSON and 404s; network and TLS failures say so', async () => {
    const cases: [() => Response | Promise<Response>, string][] = [
      [
        () => new Response(null, { status: 301, headers: { location: 'https://evil.example.test' } }),
        'AB_AGILITY_WRONG_INSTANCE',
      ],
      [
        () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
        'AB_AGILITY_WRONG_INSTANCE',
      ],
      [() => json(200, { hello: 'world' }), 'AB_AGILITY_WRONG_INSTANCE'],
      [() => json(404, {}), 'AB_AGILITY_WRONG_INSTANCE'],
      [() => new Response('', { status: 526 }), 'AB_AGILITY_TLS'],
      [
        () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })),
        'AB_AGILITY_UNAVAILABLE',
      ],
      [
        () =>
          Promise.reject(
            new TypeError('fetch failed', { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }),
          ),
        'AB_AGILITY_TLS',
      ],
    ];
    for (const [answer, code] of cases) {
      const r = await probeInstance(async () => answer(), FAKE_BASE_URL);
      expect(r, code).toMatchObject({ ok: false, code });
    }
  });
});

describe('services with a validator', () => {
  let storage: Storage;
  let keyring: Keyring;
  beforeEach(async () => {
    storage = createMemoryStorage({ now: () => NOW });
    keyring = await Keyring.create(generateMasterKey(1));
  });

  function svc(options: FakeAgilityOptions = {}) {
    const { host, sent } = services(options);
    return {
      s: accessServices({
        storage,
        keyring,
        tools: TOOLS,
        now: () => NOW,
        validator: credentialValidator(host),
      }),
      sent,
    };
  }

  it('probes a new instance before storing it, and records its fingerprint', async () => {
    const { s } = svc({
      override: (req) =>
        req.url.endsWith('meta.v1/Member') ? json(200, { Token: 'Member' }, { etag: '"1.a"' }) : undefined,
    });
    expect((await s.instances.create({ label: 'x', baseUrl: FAKE_BASE_URL })).metaFingerprint).toBe('"1.a"');
    const { s: bad } = svc({
      override: () => new Response(null, { status: 302, headers: { location: 'https://x.test' } }),
    });
    await expect(
      bad.instances.create({ label: 'y', baseUrl: 'https://not-agility.example.test/x' }),
    ).rejects.toThrow(UpstreamCheckError);
    expect(await storage.instances.list()).toHaveLength(1);
  });

  it('validates on save: member, reach and status; the hint shows only the last 4 characters', async () => {
    const { s } = svc();
    const inst = await s.instances.create({ label: 'x', baseUrl: FAKE_BASE_URL });
    const c = await s.credentials.create({
      instanceId: inst.id,
      ownerUserId: null,
      label: 'svc',
      token: TOKEN,
    });
    expect(c).toMatchObject({
      validationStatus: 'valid',
      validatedAt: NOW,
      memberOid: 'Member:20',
      memberName: 'Ann Example',
      reachableScopeIds: ['Scope:1001', 'Scope:1002'],
      tokenHint: '9876',
    });
    expect(JSON.stringify(c)).not.toContain(TOKEN.slice(0, -4));
  });

  it('a revoked token becomes invalid; an outage leaves the status and records the code', async () => {
    let mode: 'ok' | 'revoked' | 'down' = 'ok';
    const { s } = svc({
      override: (req) =>
        req.url.includes('meta.v1')
          ? undefined
          : mode === 'revoked'
            ? json(401, {})
            : mode === 'down'
              ? json(503, {})
              : undefined,
    });
    const inst = await s.instances.create({ label: 'x', baseUrl: FAKE_BASE_URL });
    const c = await s.credentials.create({
      instanceId: inst.id,
      ownerUserId: null,
      label: 'svc',
      token: TOKEN,
    });
    mode = 'down';
    expect(await s.credentials.validate(c.id)).toMatchObject({
      validationStatus: 'valid',
      validationErrorCode: 'AB_AGILITY_UNAVAILABLE',
    });
    mode = 'revoked';
    expect(await s.credentials.validate(c.id)).toMatchObject({
      validationStatus: 'invalid',
      validationErrorCode: 'AB_AGILITY_AUTH',
    });
    mode = 'ok';
    expect(await s.credentials.revalidate(NOW + 1)).toBe(1);
    expect((await storage.credentials.get(c.id))?.validationStatus).toBe('valid');
    expect(await s.credentials.revalidate(NOW - 1)).toBe(0);
  });

  it('a retarget probes the new origin first: a bad origin revokes nothing', async () => {
    let probeOk = true;
    const { s } = svc({
      override: (req) =>
        req.url.endsWith('meta.v1/Member') && !probeOk
          ? new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
          : undefined,
    });
    const inst = await s.instances.create({ label: 'x', baseUrl: FAKE_BASE_URL });
    await s.credentials.create({ instanceId: inst.id, ownerUserId: null, label: 'svc', token: TOKEN });
    probeOk = false;
    await expect(s.instances.retarget(inst.id, { baseUrl: 'https://evil.example.test/x' })).rejects.toThrow(
      UpstreamCheckError,
    );
    expect((await storage.credentials.list()).every((c) => c.revokedAt === null)).toBe(true);
  });
});
