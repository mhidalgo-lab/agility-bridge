// SPDX-License-Identifier: Apache-2.0
// Serves a web `fetch` handler on a loopback socket, for tests that need a real address (the Node `serve` sign-in test
// and the workerd one): the fake identity providers of packages/auth/test/helpers/fake-idp.ts.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FetchHandler = (request: Request) => Promise<Response>;

/** Serves a `FetchLike` on 127.0.0.1 (port 0); `url` has no trailing slash. */
export async function serveFetch(handler: FetchHandler): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const origin = `http://${req.headers.host}`;
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const init: RequestInit = { method: req.method ?? 'GET', headers };
      if (body !== undefined && req.method !== 'GET' && req.method !== 'HEAD') init.body = body;
      handler(new Request(new URL(req.url ?? '/', origin), init))
        .then(async (response) => {
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        })
        .catch(() => {
          res.writeHead(500);
          res.end();
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
