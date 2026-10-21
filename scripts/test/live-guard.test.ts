// SPDX-License-Identifier: Apache-2.0
// P0-12: the live harness's read-only guard and shape-only output (D-01, THREAT_MODEL A15).
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readPrivateEnvFile } from '../../live/env.ts';
import { guardedFetch } from '../../live/guarded-fetch.ts';
import { ReadOnlyViolation, readOnlyFetch } from '../../live/readonly-fetch.ts';
import { shape } from '../../live/shape.ts';
import {
  agilityClient,
  closedBreaker,
  createBudget,
  DEFAULT_LIMITS,
  Secret,
  silentLogger,
  systemClock,
  unboundedLimiter,
  webCryptoRandom,
} from '../../packages/core/src/index.ts';

const TARGET = { baseUrl: 'https://agility.example.com/Inst', token: 'FAKE-token' };

function guarded() {
  const fetchImpl = vi.fn(async () => new Response('[]', { status: 200 }));
  return { live: readOnlyFetch(TARGET, fetchImpl as unknown as typeof fetch), fetchImpl };
}

describe('readOnlyFetch', () => {
  it.each([
    ['GET', 'meta.v1/Story'],
    ['GET', 'meta.v1'],
    ['GET', 'rest-1.v1/Data/Story?sel=Name&page=1,0'],
    ['GET', 'rest-1.v1/Hist/Story/1001'],
    ['POST', 'query.v1'],
    ['POST', 'query.legacy.v1'],
  ] as const)('allows %s %s and sends the bearer token', async (method, path) => {
    const { live, fetchImpl } = guarded();
    await live(path, { method, body: { from: 'Story' } });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString().startsWith('https://agility.example.com/Inst/')).toBe(true);
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer FAKE-token');
    expect(init.redirect).toBe('manual');
  });

  it.each([
    ['POST', 'rest-1.v1/Data/Story/1001', 'a write endpoint'],
    ['POST', 'rest-1.v1/Data/Story', 'asset creation'],
    ['GET', 'rest-1.v1/Data/Story/1001?op=Delete', 'an operation'],
    ['POST', 'rest-1.v1/Data/Story/1001?op=QuickClose', 'an operation'],
    ['POST', 'api/asset', 'the asset API'],
    ['GET', 'query.v1', 'a GET to query.v1'],
    ['GET', 'rest-1.v1/New/Story', 'the New template'],
    ['GET', 'attachment.img/1', 'attachment content'],
    ['GET', 'https://evil.example.com/Inst/meta.v1', 'another host'],
    ['GET', 'https://agility.example.com/Other/meta.v1', 'another instance'],
  ] as const)('refuses %s %s (%s) without sending anything', async (method, path, _why) => {
    const { live, fetchImpl } = guarded();
    await expect(live(path, { method })).rejects.toBeInstanceOf(ReadOnlyViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a redirect instead of following it', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://x' } }),
    );
    const live = readOnlyFetch(TARGET, fetchImpl as unknown as typeof fetch);
    await expect(live('meta.v1')).rejects.toThrow(/redirect/);
  });

  it('refuses a plain-HTTP instance', () => {
    expect(() => readOnlyFetch({ baseUrl: 'http://agility.example.com/Inst', token: 'x' })).toThrow(
      ReadOnlyViolation,
    );
  });
});

describe('shape', () => {
  it('replaces strings and numbers with markers, masks custom attribute names and caps arrays', () => {
    const tenant = [
      [
        {
          _oid: 'Story:1001',
          Name: 'Secret roadmap item',
          Estimate: 3,
          Custom_ClientName: 'ACME',
          Done: false,
        },
        { _oid: 'Story:1002' },
        {},
        {},
      ],
    ];
    expect(shape(tenant)).toEqual([
      [
        {
          _oid: '<string>',
          Name: '<string>',
          Estimate: '<number>',
          '<Custom_…>': '<string>',
          Done: '<boolean>',
        },
        { _oid: '<string>' },
        {},
        '…(4 items)',
      ],
    ]);
    expect(JSON.stringify(shape(tenant))).not.toMatch(/Secret|ACME|1001|Story:/);
  });
});

describe('readPrivateEnvFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-liveenv-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a chmod-600 file and refuses a group- or world-readable one', () => {
    const file = join(dir, 'live.env');
    writeFileSync(
      file,
      '# comment\nAB_LIVE_AGILITY_URL="https://agility.example.com/Inst"\nexport AB_LIVE_AGILITY_TOKEN=FAKE\n',
    );
    chmodSync(file, 0o600);
    expect(readPrivateEnvFile(file)).toEqual({
      AB_LIVE_AGILITY_URL: 'https://agility.example.com/Inst',
      AB_LIVE_AGILITY_TOKEN: 'FAKE',
    });
    chmodSync(file, 0o644);
    expect(() => readPrivateEnvFile(file)).toThrow(/chmod 600/);
  });

  it('returns undefined when the file does not exist', () => {
    expect(readPrivateEnvFile(join(dir, 'missing.env'))).toBeUndefined();
  });
});

describe('guardedFetch (P1-12: the production client behind the guard)', () => {
  const setup = () => {
    const fetchImpl = vi.fn(
      async () => new Response('[[]]', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const ctx = {
      requestId: 'r',
      instance: { id: 'live', baseUrl: TARGET.baseUrl },
      credential: { id: 'live', kind: 'personal' as const, token: new Secret(TARGET.token) },
      projects: { allowed: [], includeChildren: true },
      assetTypes: { deny: [] },
      limits: DEFAULT_LIMITS,
      budget: createBudget(10),
      limiter: unboundedLimiter,
      breaker: closedBreaker,
      fetch: guardedFetch(TARGET, fetchImpl as unknown as typeof fetch),
      logger: silentLogger,
      clock: systemClock,
      random: webCryptoRandom,
    };
    return { client: agilityClient(ctx, { sleep: async () => {} }), fetchImpl };
  };

  it('lets the client read', async () => {
    const { client, fetchImpl } = setup();
    await client.query({ from: 'Story', select: ['ID'] });
    await client.meta('Story');
    await client.data('Story', 1001);
    await client.hist('Story', 1001);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['restWrite', (c: ReturnType<typeof setup>['client']) => c.restWrite('Story', 1001, '<Asset/>')],
    [
      'restWrite with an operation',
      (c: ReturnType<typeof setup>['client']) => c.restWrite('Story', 1001, '<Asset/>', 'QuickClose'),
    ],
    ['assetCommand', (c: ReturnType<typeof setup>['client']) => c.assetCommand({ from: 'Story' })],
  ])('refuses %s before anything is sent', async (_name, call) => {
    const { client, fetchImpl } = setup();
    await expect(call(client)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses another host and plain HTTP', () => {
    const f = guardedFetch(TARGET, vi.fn() as unknown as typeof fetch);
    expect(() =>
      f(new Request('https://evil.example/Inst/query.v1', { method: 'POST', redirect: 'manual' })),
    ).toThrow(ReadOnlyViolation);
    expect(() => guardedFetch({ ...TARGET, baseUrl: 'http://agility.example.com/Inst' })).toThrow(
      ReadOnlyViolation,
    );
  });
});
