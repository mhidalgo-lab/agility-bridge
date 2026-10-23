// SPDX-License-Identifier: Apache-2.0
// What reaches an identity provider and what comes back (P4-01, THREAT_MODEL T11): bounded in time and size, no
// redirects, JSON only, and an error never repeats the response body.
import { describe, expect, it } from 'vitest';
import { checkEndpoint, IDP_MAX_RESPONSE_BYTES, idpJson, urlFetch } from '../../src/identity/http.ts';
import { isIdentityError } from '../../src/index.ts';

const serve = (res: () => Response) => urlFetch(async () => res());

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (error) {
    if (isIdentityError(error)) return `${error.code}: ${error.message}`;
    throw error;
  }
}

describe('idpJson', () => {
  it('parses JSON of any status and returns the status', async () => {
    const f = serve(() => new Response('{"a":1}', { status: 400 }));
    expect(await idpJson(f, 'https://idp.example.test/x')).toEqual({ status: 400, body: { a: 1 } });
  });

  it('refuses redirects (never followed, never trusted)', async () => {
    let init: RequestInit | undefined;
    const f = urlFetch(async (request) => {
      init = { redirect: request.redirect };
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } });
    });
    expect(await reason(idpJson(f, 'https://idp.example.test/x'))).toMatch(/^idp_unavailable: .*redirect/);
    expect(init?.redirect).toBe('manual');
  });

  it('refuses a body above the cap, declared or streamed, without reading it all', async () => {
    const declared = serve(
      () => new Response('{}', { headers: { 'content-length': String(IDP_MAX_RESPONSE_BYTES + 1) } }),
    );
    expect(await reason(idpJson(declared, 'https://idp.example.test/x'))).toMatch(/too large/);
    let pulled = 0;
    const streamed = serve(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 64 * 1024;
              controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
            },
          }),
        ),
    );
    expect(await reason(idpJson(streamed, 'https://idp.example.test/x'))).toMatch(/too large/);
    expect(pulled).toBeLessThan(IDP_MAX_RESPONSE_BYTES + 3 * 64 * 1024);
  });

  it('answers non-JSON and network failures as unavailable, without the body', async () => {
    const secret = `leak-${crypto.randomUUID()}`;
    const html = await reason(
      idpJson(
        serve(() => new Response(`<html>${secret}</html>`)),
        'https://idp.example.test/x',
      ),
    );
    expect(html).toMatch(/^idp_unavailable/);
    expect(html).not.toContain(secret);
    const down = await reason(
      idpJson(
        urlFetch(async () => {
          throw new TypeError(`connect failed ${secret}`);
        }),
        'https://idp.example.test/x',
      ),
    );
    expect(down).toMatch(/^idp_unavailable/);
    expect(down).not.toContain(secret);
  });

  it('gives up after the timeout', async () => {
    const hang = urlFetch(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () =>
            reject(new DOMException('timed out', 'TimeoutError')),
          );
        }),
    );
    const outcome = await reason(idpJson(hang, 'https://idp.example.test/x', {}, 'discovery', 30));
    expect(outcome).toMatch(/^idp_unavailable: discovery is unreachable/);
  });
});

describe('checkEndpoint', () => {
  it('accepts https URLs, and http only for loopback when allowed', () => {
    expect(checkEndpoint('https://idp.example.test/token', false)?.href).toBe(
      'https://idp.example.test/token',
    );
    expect(checkEndpoint('http://idp.example.test/token', false)).toBeNull();
    expect(checkEndpoint('http://127.0.0.1:9000/token', false)).toBeNull();
    expect(checkEndpoint('http://127.0.0.1:9000/token', true)?.hostname).toBe('127.0.0.1');
    expect(checkEndpoint('http://idp.example.test/token', true)).toBeNull();
  });

  it('refuses credentials, fragments, other schemes and oversized values', () => {
    for (const bad of [
      'https://user:pw@idp.example.test/x',
      'https://idp.example.test/x#frag',
      'ftp://idp.example.test/x',
      'javascript:alert(1)',
      'not a url',
      `https://idp.example.test/${'a'.repeat(2100)}`,
      42,
      undefined,
    ]) {
      expect(checkEndpoint(bad, true), String(bad).slice(0, 40)).toBeNull();
    }
  });
});
