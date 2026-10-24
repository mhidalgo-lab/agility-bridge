// SPDX-License-Identifier: Apache-2.0
// The Workers fetcher for client metadata documents (P5-03, T11): only with `global_fetch_strictly_public` (set in
// `wrangler.jsonc`; workerd exposes it as `Cloudflare.compatibilityFlags`, stubbed here because these tests run in Node),
// never following redirects. No real fetch: the fetcher is injected. The Worker end to end is `oauth.test.ts`.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasStrictlyPublicFetch, strictlyPublicClientMetadataFetch } from '../src/cimd-fetch.ts';

/** Runs `body` with the runtime flag stubbed as workerd reports it. */
async function withFlag(on: boolean, body: () => void | Promise<void>): Promise<void> {
  const g = globalThis as { Cloudflare?: unknown };
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'Cloudflare');
  try {
    Object.defineProperty(globalThis, 'Cloudflare', {
      value: { compatibilityFlags: on ? { global_fetch_strictly_public: true } : {} },
      configurable: true,
    });
    await body();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'Cloudflare', saved);
    else delete g.Cloudflare;
  }
}

describe('strictlyPublicClientMetadataFetch', () => {
  it('reads the flag from the runtime, and is off where the runtime says nothing', async () => {
    expect(hasStrictlyPublicFetch()).toBe(false);
    await withFlag(true, () => expect(hasStrictlyPublicFetch()).toBe(true));
    await withFlag(false, () => expect(hasStrictlyPublicFetch()).toBe(false));
  });

  it('wrangler.jsonc sets the flag the runtime check reads', () => {
    const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    expect(config).toMatch(/"compatibility_flags"\s*:\s*\[[^\]]*"global_fetch_strictly_public"/);
  });

  it('asks for JSON with manual redirects and the caller’s signal', () =>
    withFlag(true, async () => {
      const seen: { url: string; init: RequestInit | undefined }[] = [];
      const fetcher = strictlyPublicClientMetadataFetch((async (url: string, init?: RequestInit) => {
        seen.push({ url, init });
        return new Response(null, { status: 302, headers: { location: 'https://10.0.0.1/' } });
      }) as unknown as typeof fetch);
      expect(fetcher).not.toBeNull();
      const ac = new AbortController();
      const res = await fetcher?.('https://claude.ai/oauth/claude-code-client-metadata', {
        signal: ac.signal,
      });
      expect(res?.status).toBe(302);
      expect(seen[0]?.url).toBe('https://claude.ai/oauth/claude-code-client-metadata');
      expect(seen[0]?.init).toMatchObject({ method: 'GET', redirect: 'manual', signal: ac.signal });
      expect(new Headers(seen[0]?.init?.headers).get('accept')).toBe('application/json');
    }));

  it('is off when the runtime has no strictly-public fetch', () =>
    withFlag(false, () => {
      expect(strictlyPublicClientMetadataFetch()).toBeNull();
    }));
});
