// SPDX-License-Identifier: Apache-2.0
// The Node fetcher for OAuth client metadata documents (P5-03, T11, L-088): real HTTP against a local fake origin
// (no network) with the bounds of the http-app (no redirects, 5 KiB, a time limit), and the public-only connect-time
// guard with every kind of non-public destination. The guard's DNS cases are in `client-metadata-lookup.test.ts`.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CIMD_MAX_BYTES, ClientMetadataError, fetchMetadataDocument } from '@agility-bridge/http-app';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClientMetadataFetch, PrivateAddressError } from '../src/agility-fetch.ts';

let server: Server;
let base = '';
const seen: { url: string; accept: string | undefined; method: string | undefined }[] = [];
const sockets = new Set<import('node:net').Socket>();

const handlers: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {
  '/good': (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=900' });
    res.end(
      JSON.stringify({
        client_id: `${base}/good`,
        client_name: 'Local',
        redirect_uris: ['http://127.0.0.1:1/cb'],
      }),
    );
  },
  '/redirect': (_req, res) => {
    res.writeHead(302, { location: `${base}/good` });
    res.end();
  },
  '/big': (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ pad: 'x'.repeat(CIMD_MAX_BYTES * 4) }));
  },
  '/endless': (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const timer = setInterval(() => res.write('x'.repeat(1024)), 5);
    res.on('close', () => clearInterval(timer));
  },
  '/stall': (_req, res) => {
    // Headers and a first chunk, then silence: a slow-loris document.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"client_id":');
  },
  '/silent': () => {
    // Never answers at all.
  },
};

const routes = new Map(Object.entries(handlers));

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', accept: req.headers['accept'], method: req.method });
    (routes.get(req.url ?? '') ?? ((_r, s) => s.writeHead(404).end()))(req, res);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

const open = createClientMetadataFetch({ publicOnly: false });
const signal = () => ({ signal: new AbortController().signal });
const reasonOf = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.catch((e: unknown) => e);
  return error instanceof ClientMetadataError ? error.reason : `unexpected: ${String(error)}`;
};

describe('the document fetch over real HTTP (guard off, so the local origin is reachable)', () => {
  it('asks for JSON with GET and returns a good document', async () => {
    seen.length = 0;
    const { client, ttlSeconds } = await fetchMetadataDocument(`${base}/good`, open, 1);
    expect(client.clientName).toBe('Local');
    expect(ttlSeconds).toBe(900);
    expect(seen).toEqual([{ url: '/good', accept: 'application/json', method: 'GET' }]);
  });

  it('does not follow a redirect: the 3xx is the answer, and the target is never requested', async () => {
    seen.length = 0;
    const response = await open(`${base}/redirect`, signal());
    expect(response.status).toBe(302);
    expect(seen.map((s) => s.url)).toEqual(['/redirect']);
    seen.length = 0;
    expect(await reasonOf(fetchMetadataDocument(`${base}/redirect`, open, 1))).toBe('redirect');
    expect(seen.map((s) => s.url)).toEqual(['/redirect']);
  });

  it('cuts an oversized document at 5 KiB and an endless one without reading it to the end', async () => {
    expect(await reasonOf(fetchMetadataDocument(`${base}/big`, open, 1))).toBe('too_large');
    expect(await reasonOf(fetchMetadataDocument(`${base}/endless`, open, 1))).toBe('too_large');
  });

  it('gives up on a server that never answers and on one that stops sending', async () => {
    const started = Date.now();
    expect(await reasonOf(fetchMetadataDocument(`${base}/silent`, open, 1, 300))).toBe('timeout');
    expect(await reasonOf(fetchMetadataDocument(`${base}/stall`, open, 1, 300))).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('a 404 is a failure', async () => {
    expect(await reasonOf(fetchMetadataDocument(`${base}/missing`, open, 1))).toBe('http_status');
  });
});

describe('the shipped fetcher: public addresses only, checked at connect time', () => {
  const guarded = createClientMetadataFetch();

  it('never reaches the local origin: loopback by address and by name', async () => {
    seen.length = 0;
    expect(await reasonOf(fetchMetadataDocument(`${base}/good`, guarded, 1))).toBe('fetch_failed');
    const port = new URL(base).port;
    expect(await reasonOf(fetchMetadataDocument(`http://localhost:${port}/good`, guarded, 1))).toBe(
      'fetch_failed',
    );
    expect(seen).toEqual([]);
  });

  it.each([
    ['loopback', 'http://127.0.0.1:9/x'],
    ['loopback, whole /8', 'http://127.200.3.4:9/x'],
    ['private 10/8', 'http://10.0.0.5:9/x'],
    ['private 172.16/12', 'http://172.20.1.1:9/x'],
    ['private 192.168/16', 'http://192.168.1.1:9/x'],
    ['CGNAT', 'http://100.64.0.1:9/x'],
    ['link-local', 'http://169.254.10.10:9/x'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['this network', 'http://0.0.0.0:9/x'],
    ['multicast', 'http://224.0.0.1:9/x'],
    ['documentation range', 'http://192.0.2.1:9/x'],
    ['decimal IPv4', 'http://2130706433:9/x'],
    ['hex IPv4', 'http://0x7f.0.0.1:9/x'],
    ['short IPv4', 'http://127.1:9/x'],
    ['IPv6 loopback', 'http://[::1]:9/x'],
    ['IPv6 unspecified', 'http://[::]:9/x'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]:9/x'],
    ['IPv4-mapped IPv6 private', 'http://[::ffff:10.0.0.1]:9/x'],
    ['NAT64 of the metadata address', 'http://[64:ff9b::a9fe:a9fe]:9/x'],
    ['6to4 of a private address', 'http://[2002:0a00:0001::1]:9/x'],
    ['unique local IPv6', 'http://[fd00::1]:9/x'],
    ['link-local IPv6', 'http://[fe80::1]:9/x'],
  ])('refuses %s (%s) before any connection', async (_label, url) => {
    await expect(guarded(url, signal())).rejects.toThrow(PrivateAddressError);
  });
});
