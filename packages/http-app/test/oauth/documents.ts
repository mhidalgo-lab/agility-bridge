// SPDX-License-Identifier: Apache-2.0
// A fake origin of OAuth client metadata documents (P5-03), shared by every host of the OAuth suites: no network. Node
// hosts hand `fetcher` to the app; the Worker's outbound requests are answered by `handle` (Miniflare `outboundService`).
import type { ClientMetadataFetch } from '../../src/index.ts';

export interface DocumentSpec {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** A body: text, bytes or a stream factory (a body that keeps sending). */
  readonly body?: string | Uint8Array | (() => ReadableStream<Uint8Array>);
  /** Answers only after this long (honours the request's abort signal). */
  readonly delayMs?: number;
}

export interface FakeDocuments {
  /** What the app asked for, in order: the URL and the method, redirect mode and Accept header it used. */
  readonly requests: {
    readonly url: string;
    readonly method: string;
    readonly redirect: string;
    readonly accept: string | null;
  }[];
  /** URLs fetched so far. */
  fetched(): string[];
  /** Serves a document at `url`. */
  serve(url: string, spec: DocumentSpec): void;
  /** Serves the JSON metadata of a well-formed client at `url`, with `over` merged over the valid fields. */
  serveClient(url: string, over?: Record<string, unknown>, headers?: Record<string, string>): void;
  /**
   * Whether `requests[].redirect` is what the app asked for. False for the Worker's outbound service, which re-creates the
   * request (always `follow`); `apps/worker/test/cimd-fetch.test.ts` covers `manual` there.
   */
  readonly observesRedirectMode: boolean;
  /** The guarded fetcher a Node host injects. */
  readonly fetcher: ClientMetadataFetch;
  /** Answers a request as the fake origin (the Worker's outbound service). */
  handle(request: Request): Promise<Response>;
}

/** The valid document of a client at `url` (a loopback redirect and one on its own host). */
export function clientDocument(url: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: url,
    client_name: 'Document client',
    redirect_uris: ['http://127.0.0.1:53682/callback', `${new URL(url).origin}/callback`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...over,
  };
}

export function createFakeDocuments(
  options: { readonly observesRedirectMode?: boolean } = {},
): FakeDocuments {
  const served = new Map<string, DocumentSpec>();
  const requests: { url: string; method: string; redirect: string; accept: string | null }[] = [];
  const handle = async (request: Request): Promise<Response> => {
    requests.push({
      url: request.url,
      method: request.method,
      redirect: request.redirect,
      accept: request.headers.get('accept'),
    });
    const spec = served.get(request.url);
    if (spec === undefined) return new Response('not found', { status: 404 });
    if (spec.delayMs !== undefined) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, spec.delayMs);
        request.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const body = typeof spec.body === 'function' ? spec.body() : (spec.body ?? '');
    return new Response(body as ConstructorParameters<typeof Response>[0], {
      status: spec.status ?? 200,
      headers: spec.headers ?? {},
    });
  };
  return {
    observesRedirectMode: options.observesRedirectMode !== false,
    requests,
    fetched: () => requests.map((r) => r.url),
    serve: (url, spec) => {
      served.set(url, spec);
    },
    serveClient(url, over, headers) {
      served.set(url, {
        headers: { 'content-type': 'application/json', ...(headers ?? {}) },
        body: JSON.stringify(clientDocument(url, over)),
      });
    },
    fetcher: (url, init) =>
      handle(
        new Request(url, {
          method: 'GET',
          redirect: 'manual',
          headers: { accept: 'application/json' },
          signal: init.signal,
        }),
      ),
    handle,
  };
}
