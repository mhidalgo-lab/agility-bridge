// SPDX-License-Identifier: Apache-2.0
// P0-12: the live harness's read-only guard and shape-only output (D-01, THREAT_MODEL A15).
import { describe, expect, it, vi } from 'vitest';
import { ReadOnlyViolation, readOnlyFetch } from '../../live/readonly-fetch.ts';
import { shape } from '../../live/shape.ts';

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
