// SPDX-License-Identifier: Apache-2.0
// The one way tools talk to Agility (ARCHITECTURE §6.1, ADR-0010): fixed endpoints under the configured instance, one
// identity per call (L-152), bounded retries for reads, per-credential concurrency, a budget charged per attempt, byte
// caps and precise errors. Raw Agility bodies never leave this module except as untrusted error details.
import type { ToolContext } from '../context.ts';
import { AbError, ErrorCode } from '../errors.ts';
import { VERSION } from '../version.ts';
import { readCapped } from './body.ts';
import { decodeResponse, encodeResponse } from './query-cache.ts';
import { parseXml, type XmlElement } from './xml.ts';

export interface AgilityResponse<T> {
  readonly status: number;
  readonly data: T;
  readonly bytes: number;
  /** `meta.v1` answers `"<version>.<schema stamp>"` (P0-06); the metadata service keys its cache on it. */
  readonly etag?: string;
  /** A 2xx to a write whose body was empty or not readable XML: the write happened, the answer is not usable (P7-09). */
  readonly unreadable?: boolean;
}

export interface AgilityClientOptions {
  /** Waits between attempts; tests pass a fake. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Attempts per read, the first included (ADR-0010: 3). */
  readonly maxAttempts?: number;
  /** Longest wait a retry may take; a longer Retry-After is reported instead (ADR-0010: 10 s). */
  readonly maxRetryWaitMs?: number;
  /** First backoff step of the full-jitter exponential backoff (ADR-0010: 500 ms). */
  readonly backoffBaseMs?: number;
}

/** What `attachmentContent` returns: the bytes (within the cap) and the response's `type/subtype`. */
export interface AttachmentContent {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** A `query.v1` query; its shape is built and validated by the query compiler (P1-04), never by callers. */
export type QueryBody = Readonly<Record<string, unknown>>;

type Endpoint =
  | 'query.v1'
  | 'query.legacy.v1'
  | 'meta.v1'
  | 'rest-1.v1/Data'
  | 'rest-1.v1/Hist'
  | 'api/asset'
  | 'attachments.img';

interface Call {
  readonly endpoint: Endpoint;
  readonly method: 'GET' | 'POST';
  readonly segments: readonly string[];
  readonly params?: URLSearchParams;
  readonly body?: string;
  readonly contentType?: string;
  readonly expect: 'json' | 'xml' | 'binary';
  /** For `binary`: the stream cap and the content types the response may have (P6-04). */
  readonly binary?: { readonly maxBytes: number; readonly allowedTypes: readonly string[] };
  /** Writes are never retried (L-047, ADR-0013). */
  readonly write: boolean;
  /** For the budget message: "before <what>". */
  readonly what: string;
}

type Attempt =
  | { readonly ok: true; readonly response: AgilityResponse<unknown> }
  | {
      readonly ok: false;
      readonly error: AbError;
      readonly retryable: boolean;
      readonly retryAfterMs?: number;
      readonly rateLimited?: boolean;
    };

const ASSET_TYPE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ATTRIBUTE_RE = /^[A-Za-z@][A-Za-z0-9_.@]{0,199}$/;
const ID_RE = /^[1-9][0-9]{0,11}$/;
const ERROR_BODY_BYTES = 64 * 1024;
const MAX_BACKOFF_MS = 8_000;

/** Node's TLS failure codes, found on `error.cause.code` (undici). */
const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REVOKED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function badArgument(what: string): AbError {
  return new AbError(ErrorCode.InputInvalid, `Invalid ${what}.`);
}

function assetType(name: string): string {
  if (!ASSET_TYPE_RE.test(name)) throw badArgument('asset type name');
  return name;
}

function assetId(id: number | string): string {
  const s = String(id);
  if (!ID_RE.test(s)) throw badArgument('asset id');
  return s;
}

function selection(sel: readonly string[] | undefined): URLSearchParams | undefined {
  if (sel === undefined || sel.length === 0) return undefined;
  for (const a of sel) if (!ATTRIBUTE_RE.test(a)) throw badArgument('attribute name');
  return new URLSearchParams({ sel: sel.join(',') });
}

const tls = (): AbError =>
  new AbError(
    ErrorCode.AgilityTls,
    'Could not connect to Agility securely: the certificate is not trusted, or the host is unreachable.',
    {
      hint: 'Check the instance URL. An on-premises instance with a private CA needs the Node or Docker deployment with AB_CA_FILE (Cloudflare Workers cannot trust private CAs).',
    },
  );

const wrongInstance = (why: string): AbError =>
  new AbError(
    ErrorCode.AgilityWrongInstance,
    `The configured Agility URL did not answer like Agility (${why}).`,
    {
      hint: 'Check the instance URL: use the address you open Agility at, without /Default.aspx or a login page.',
    },
  );

const unavailable = (why: string): AbError =>
  new AbError(ErrorCode.AgilityUnavailable, `Agility is unavailable (${why}).`, {
    hint: 'Try again in a moment.',
  });

const timeout = (ms: number): AbError =>
  new AbError(ErrorCode.AgilityTimeout, `Agility did not answer within ${Math.round(ms / 1000)} s.`, {
    hint: 'Narrow the request (fewer rows, fewer fields, no ChangeDate sort) and try again.',
  });

function rateLimited(retryAfterSeconds: number | undefined, circuitOpen: boolean): AbError {
  const wait = retryAfterSeconds === undefined ? 'Wait a little' : `Wait ${retryAfterSeconds} s`;
  return new AbError(
    ErrorCode.AgilityRateLimited,
    circuitOpen
      ? 'Agility keeps refusing requests for this token (quota), so requests are paused for a moment.'
      : "Agility refused the request: this token's request quota is used up (429).",
    {
      hint: `${wait}, then retry; narrow the request so it needs fewer calls.`,
      ...(retryAfterSeconds === undefined ? {} : { details: { retryAfterSeconds } }),
      localDetails: true,
    },
  );
}

/** Seconds from `Retry-After` (seconds or an HTTP date) or the 429 body's `RetryAfter`. */
function retryAfterMs(res: Response, body: string, now: number): number | undefined {
  const header = res.headers.get('retry-after');
  if (header !== null) {
    if (/^\s*\d+\s*$/.test(header)) return Number(header) * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  try {
    const parsed = JSON.parse(body) as { RetryAfter?: unknown };
    const v = Number(parsed.RetryAfter);
    if (Number.isFinite(v) && v >= 0) return v * 1000;
  } catch {
    // Not JSON: no body hint.
  }
  return undefined;
}

/**
 * The trusted next step for a request Agility refused. Agility's own message is never shown to the model, so this hint is
 * the only guidance in the result and must name a route that works.
 */
export const UPSTREAM_REFUSAL_HINT: string =
  "Agility's own message is not shown here (it is in the server log). Check asset numbers, attribute names and values " +
  'with describe_asset_type; read one item by number with get_work_item or get_assets, or find items by words in the name ' +
  'with search_work_items.';

/** `{ error, exceptions: [{ type, message }] }` (P0-06) for the server log only: Agility text, possibly echoing input. */
function agilityErrorDetails(body: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; exceptions?: unknown };
    const messages = Array.isArray(parsed.exceptions)
      ? parsed.exceptions
          .map((e) =>
            e !== null && typeof e === 'object' ? (e as { message?: unknown }).message : undefined,
          )
          .filter((m): m is string => typeof m === 'string')
          .slice(0, 5)
          .map((m) => m.slice(0, 500))
      : [];
    const error = typeof parsed.error === 'string' ? parsed.error.slice(0, 500) : undefined;
    if (error === undefined && messages.length === 0) return undefined;
    return { ...(error === undefined ? {} : { error }), ...(messages.length === 0 ? {} : { messages }) };
  } catch {
    return undefined;
  }
}

/** `type/subtype` in lower case, without parameters (`text/plain; charset=utf-8` is `text/plain`). */
export function mediaType(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

const typeRefused = (): AbError =>
  new AbError(ErrorCode.InputInvalid, 'Agility answered with a content type this workspace does not allow.', {
    hint: 'Only the text types the deployment allows (AB_ATTACHMENT_TYPES) are returned; nothing was read.',
  });

const tooBig = (maxBytes: number): AbError =>
  new AbError(
    ErrorCode.LimitResponseTooLarge,
    `The attachment is larger than ${Math.round(maxBytes / 1024)} KiB, the most this workspace returns.`,
    {
      hint: 'Nothing was returned. Open the attachment in Agility, or ask an administrator to raise the attachment size limit.',
      details: { maxBytes },
      localDetails: true,
    },
  );

function looksLikeHtml(contentType: string, text: string): boolean {
  return /\bhtml\b/i.test(contentType) || /^\s*<(?:!doctype\s+html|html)\b/i.test(text);
}

function classifyThrown(error: unknown, timeoutMs: number): Attempt {
  if (error instanceof AbError) return { ok: false, error, retryable: false };
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError')
    return { ok: false, error: timeout(timeoutMs), retryable: false };
  const cause =
    error instanceof Error ? (error.cause as { code?: unknown; message?: unknown } | undefined) : undefined;
  const code = typeof cause?.code === 'string' ? cause.code : '';
  const message = `${error instanceof Error ? error.message : String(error)} ${typeof cause?.message === 'string' ? cause.message : ''}`;
  // Local workerd reports an untrusted certificate as an opaque "internal error; reference = …" (L-160).
  if (
    TLS_CODES.has(code) ||
    /certificate|\bSSL\b|\bTLS\b/i.test(message) ||
    /^internal error/i.test(message)
  ) {
    return { ok: false, error: tls(), retryable: false };
  }
  return { ok: false, error: unavailable('network error'), retryable: true };
}

/**
 * The Agility client for one tool call. Created from the call's context, so every request uses that call's instance,
 * credential, budget, limiter and breaker (L-152, T21); tools never build URLs or headers.
 */
export class AgilityClient {
  readonly #ctx: ToolContext;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxAttempts: number;
  readonly #maxRetryWaitMs: number;
  readonly #backoffBaseMs: number;

  constructor(ctx: ToolContext, options: AgilityClientOptions = {}) {
    this.#ctx = ctx;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#maxRetryWaitMs = options.maxRetryWaitMs ?? 10_000;
    this.#backoffBaseMs = options.backoffBaseMs ?? 500;
  }

  /**
   * `POST query.v1` with one query or several (one result set per query). Answered from the query cache when the call's
   * context has one and the caller has no write tools (P8-01); `fresh` skips it, and the write layer's own reads use it
   * (a write must decide on current data, ADR-0013).
   */
  async query<T = unknown[]>(
    queries: QueryBody | readonly QueryBody[],
    options: { legacy?: boolean; fresh?: boolean } = {},
  ): Promise<AgilityResponse<T>> {
    const endpoint = options.legacy === true ? 'query.legacy.v1' : 'query.v1';
    const send = () =>
      this.#send({
        endpoint,
        method: 'POST',
        segments: [endpoint],
        body: JSON.stringify(queries),
        contentType: 'application/json',
        expect: 'json',
        write: false,
        what: 'the Agility query',
      }) as Promise<AgilityResponse<T>>;
    const scope = this.#ctx.queryCache;
    // Writers always read live: a stale answer next to a write would mislead the person approving it and the agent
    // checking it, so a caller with write tools never caches.
    if (scope === undefined || options.fresh === true || this.#ctx.workspace.writes.enabled) return send();
    let id: string;
    try {
      id = await scope.cache.key(this.#ctx, scope, endpoint, queries);
      const text = await scope.cache.get(id, true);
      const hit = text === undefined ? undefined : decodeResponse<T>(text);
      if (hit !== undefined) {
        this.#ctx.logger.debug('agility query cache hit', { endpoint });
        return hit;
      }
    } catch (error) {
      this.#ctx.logger.warn('query cache lookup failed', { error: (error as Error).name });
      return send();
    }
    const res = await send();
    try {
      await scope.cache.put(id, encodeResponse(res), true);
    } catch (error) {
      this.#ctx.logger.warn('query cache store failed', { error: (error as Error).name });
    }
    return res;
  }

  /** `GET meta.v1/<type>` (one asset type, about 90 KB) or the whole schema (about 5 MB: not on Workers). */
  meta<T = unknown>(type?: string): Promise<AgilityResponse<T>> {
    return this.#send({
      endpoint: 'meta.v1',
      method: 'GET',
      segments: type === undefined ? ['meta.v1', ''] : ['meta.v1', assetType(type)],
      expect: 'json',
      write: false,
      what: 'the Agility metadata request',
    }) as Promise<AgilityResponse<T>>;
  }

  /** `GET rest-1.v1/Data/<type>/<id>` with a validated attribute selection. */
  data<T = unknown>(type: string, id: number | string, sel?: readonly string[]): Promise<AgilityResponse<T>> {
    const params = selection(sel);
    return this.#send({
      endpoint: 'rest-1.v1/Data',
      method: 'GET',
      segments: ['rest-1.v1', 'Data', assetType(type), assetId(id)],
      ...(params === undefined ? {} : { params }),
      expect: 'json',
      write: false,
      what: 'the Agility asset request',
    }) as Promise<AgilityResponse<T>>;
  }

  /** `GET rest-1.v1/Hist/<type>/<id>`: every version of one asset (the history authority, ADR-0011). */
  hist<T = unknown>(type: string, id: number | string, sel?: readonly string[]): Promise<AgilityResponse<T>> {
    const params = selection(sel);
    return this.#send({
      endpoint: 'rest-1.v1/Hist',
      method: 'GET',
      segments: ['rest-1.v1', 'Hist', assetType(type), assetId(id)],
      ...(params === undefined ? {} : { params }),
      expect: 'json',
      write: false,
      what: 'the Agility history request',
    }) as Promise<AgilityResponse<T>>;
  }

  /**
   * `POST rest-1.v1/Data/<type>[/<id>]` with an XML asset document built by the write layer (Phase 7, ADR-0013);
   * optionally an operation (`?op=QuickClose`). Never retried.
   */
  restWrite(
    type: string,
    id: number | string | undefined,
    xml: string,
    operation?: string,
  ): Promise<AgilityResponse<XmlElement>> {
    const segments = ['rest-1.v1', 'Data', assetType(type), ...(id === undefined ? [] : [assetId(id)])];
    if (operation !== undefined && !ASSET_TYPE_RE.test(operation)) throw badArgument('operation name');
    return this.#send({
      endpoint: 'rest-1.v1/Data',
      method: 'POST',
      segments,
      ...(operation === undefined ? {} : { params: new URLSearchParams({ op: operation }) }),
      body: xml,
      contentType: 'application/xml',
      expect: 'xml',
      write: true,
      what: 'the Agility write',
    }) as Promise<AgilityResponse<XmlElement>>;
  }

  /** `POST api/asset` with a typed command document built by the write layer (Phase 7). Never retried. */
  assetCommand<T = unknown>(command: QueryBody): Promise<AgilityResponse<T>> {
    return this.#send({
      endpoint: 'api/asset',
      method: 'POST',
      segments: ['api', 'asset'],
      body: JSON.stringify(command),
      contentType: 'application/json',
      expect: 'json',
      write: true,
      what: 'the Agility write',
    }) as Promise<AgilityResponse<T>>;
  }

  /**
   * `GET attachments.img/<id>`: the content of one attachment (P6-04, THREAT_MODEL A8). The response is refused before
   * its body is read unless its content type is in `allowedTypes`, and the body is cut off as soon as it passes
   * `maxBytes` (counted on the stream, never from `Content-Length`). One request; the caller verified scope first.
   */
  attachmentContent(
    id: number | string,
    options: { readonly maxBytes: number; readonly allowedTypes: readonly string[] },
  ): Promise<AgilityResponse<AttachmentContent>> {
    return this.#send({
      endpoint: 'attachments.img',
      method: 'GET',
      segments: ['attachments.img', assetId(id)],
      expect: 'binary',
      binary: {
        maxBytes: Math.min(options.maxBytes, this.#ctx.limits.maxResponseBytes),
        allowedTypes: options.allowedTypes,
      },
      write: false,
      what: 'the attachment download',
    }) as Promise<AgilityResponse<AttachmentContent>>;
  }

  async #send(call: Call): Promise<AgilityResponse<unknown>> {
    const { budget, breaker, limiter } = this.#ctx;
    const attempts = call.write ? 1 : this.#maxAttempts;
    for (let attempt = 1; ; attempt++) {
      const openMs = breaker.openForMs();
      if (openMs > 0) throw rateLimited(Math.ceil(openMs / 1000), true);
      budget.spend(1, call.what);
      const outcome = await limiter.run(() => this.#attempt(call, attempt));
      if (outcome.ok) {
        breaker.onSuccess();
        return outcome.response;
      }
      if (outcome.rateLimited === true) breaker.onRateLimited(outcome.retryAfterMs);
      if (!outcome.retryable || attempt >= attempts) throw outcome.error;
      await this.#sleep(outcome.retryAfterMs ?? this.#backoff(attempt));
    }
  }

  /** Full jitter: a uniform wait in [0, min(cap, base · 2^(attempt-1))). */
  #backoff(attempt: number): number {
    const [a = 0, b = 0, c = 0, d = 0] = this.#ctx.random.bytes(4);
    const unit = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
    return Math.floor((unit / 2 ** 32) * Math.min(MAX_BACKOFF_MS, this.#backoffBaseMs * 2 ** (attempt - 1)));
  }

  #url(call: Call): string {
    const path = call.segments.map((s) => encodeURIComponent(s)).join('/');
    const query = call.params === undefined ? '' : `?${call.params.toString()}`;
    return `${this.#ctx.instance.baseUrl}/${path}${query}`;
  }

  async #attempt(call: Call, attempt: number): Promise<Attempt> {
    const { limits, logger, clock, credential } = this.#ctx;
    const started = clock.now();
    const timeoutMs = limits.requestTimeoutMs;
    const headers: Record<string, string> = {
      authorization: `Bearer ${credential.token.reveal()}`,
      accept:
        call.expect === 'json'
          ? 'application/json'
          : call.expect === 'binary'
            ? (call.binary?.allowedTypes.join(', ') ?? '*/*')
            : 'application/xml, text/xml',
      'user-agent': `agility-bridge/${VERSION}`,
    };
    if (call.contentType !== undefined) headers['content-type'] = call.contentType;
    const log = (status: number | string, bytes?: number) =>
      logger.debug('agility request', {
        endpoint: call.endpoint,
        method: call.method,
        attempt,
        status,
        ms: clock.now() - started,
        ...(bytes === undefined ? {} : { bytes }),
      });
    let res: Response;
    try {
      res = await this.#ctx.fetch(
        new Request(this.#url(call), {
          method: call.method,
          headers,
          ...(call.body === undefined ? {} : { body: call.body }),
          // Never follow a redirect with the token on it (L-055).
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
    } catch (error) {
      const outcome = classifyThrown(error, timeoutMs);
      log(outcome.ok ? 'ok' : outcome.error.code);
      return outcome;
    }
    try {
      return await this.#classify(call, res, (bytes) => log(res.status, bytes));
    } catch (error) {
      log(res.status);
      return classifyThrown(error, timeoutMs);
    }
  }

  async #classify(call: Call, res: Response, log: (bytes?: number) => void): Promise<Attempt> {
    const { status } = res;
    if (res.type === 'opaqueredirect' || status === 0 || (status >= 300 && status < 400)) {
      await res.body?.cancel().catch(() => {});
      log();
      return { ok: false, error: wrongInstance('it redirected elsewhere'), retryable: false };
    }
    // Cloudflare's "invalid SSL certificate": a deployed Worker gets it instead of a TLS error (L-160).
    if (status === 526) {
      await res.body?.cancel().catch(() => {});
      log();
      return { ok: false, error: tls(), retryable: false };
    }
    if (status >= 200 && status < 300) return this.#success(call, res, log);
    const { text, bytes } = await readCapped(
      res,
      Math.min(ERROR_BODY_BYTES, this.#ctx.limits.maxResponseBytes),
    ).catch(() => ({ text: '', bytes: 0 }));
    log(bytes);
    if (text !== '') this.#ctx.logger.debug('agility error body', { status, body: text.slice(0, 500) });
    switch (status) {
      case 401:
        return {
          ok: false,
          retryable: false,
          error: new AbError(ErrorCode.AgilityAuth, 'Agility rejected the access token (401).', {
            hint: 'The token is invalid or revoked, or it belongs to another instance: create a new one on the Agility Applications page and check the instance URL.',
          }),
        };
      case 403:
        return {
          ok: false,
          retryable: false,
          error: new AbError(ErrorCode.AgilityAuth, 'Agility refused this request for this member (403).', {
            hint: 'The token works, but its member lacks the permission; ask an Agility administrator.',
          }),
        };
      case 404:
        return {
          ok: false,
          retryable: false,
          error: new AbError(ErrorCode.NotFound, 'Not found or not visible with this token.', {
            hint: 'Check the number or id; the member behind the token may not have access to it.',
          }),
        };
      case 429: {
        const waitMs = retryAfterMs(res, text, this.#ctx.clock.now());
        const seconds = waitMs === undefined ? undefined : Math.ceil(waitMs / 1000);
        const tooLong = waitMs !== undefined && waitMs > this.#maxRetryWaitMs;
        return {
          ok: false,
          rateLimited: true,
          retryable: !call.write && !tooLong,
          error: rateLimited(seconds, false),
          ...(waitMs === undefined ? {} : { retryAfterMs: waitMs }),
        };
      }
      case 502:
      case 503:
      case 504:
        return { ok: false, retryable: !call.write, error: unavailable(`HTTP ${status}`) };
      default: {
        if (status >= 500) return { ok: false, retryable: false, error: unavailable(`HTTP ${status}`) };
        if (looksLikeHtml(res.headers.get('content-type') ?? '', text)) {
          return { ok: false, retryable: false, error: wrongInstance(`an HTML page with HTTP ${status}`) };
        }
        // Agility's own message is withheld from the result (P6-33, L-333): it can echo input or carry an instruction,
        // and models followed one even inside the envelope. The operator reads it in the log; the agent gets our hint.
        const details = agilityErrorDetails(text);
        if (details !== undefined)
          this.#ctx.logger.warn('agility refused the request', { status, ...details });
        return {
          ok: false,
          retryable: false,
          error: new AbError(ErrorCode.AgilityError, `Agility refused the request (HTTP ${status}).`, {
            hint: UPSTREAM_REFUSAL_HINT,
          }),
        };
      }
    }
  }

  async #binary(
    binary: NonNullable<Call['binary']>,
    res: Response,
    log: (bytes?: number) => void,
  ): Promise<Attempt> {
    const contentType = res.headers.get('content-type') ?? '';
    const type = mediaType(contentType);
    if (/\bhtml\b/i.test(type)) {
      await res.body?.cancel().catch(() => {});
      log();
      return { ok: false, retryable: false, error: wrongInstance('an HTML page, often a login page') };
    }
    if (!binary.allowedTypes.includes(type)) {
      await res.body?.cancel().catch(() => {});
      log();
      return { ok: false, retryable: false, error: typeRefused() };
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > binary.maxBytes) {
      await res.body?.cancel().catch(() => {});
      log();
      return { ok: false, retryable: false, error: tooBig(binary.maxBytes) };
    }
    // The stream is the authority: a lying or missing Content-Length changes nothing.
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (reader !== undefined) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > binary.maxBytes) {
        await reader.cancel().catch(() => {});
        log(bytes);
        return { ok: false, retryable: false, error: tooBig(binary.maxBytes) };
      }
      chunks.push(value);
    }
    log(bytes);
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const c of chunks) {
      all.set(c, offset);
      offset += c.byteLength;
    }
    return { ok: true, response: { status: res.status, data: { bytes: all, contentType: type }, bytes } };
  }

  async #success(call: Call, res: Response, log: (bytes?: number) => void): Promise<Attempt> {
    if (call.expect === 'binary' && call.binary !== undefined) return this.#binary(call.binary, res, log);
    const contentType = res.headers.get('content-type') ?? '';
    const { text, bytes } = await readCapped(res, this.#ctx.limits.maxResponseBytes);
    log(bytes);
    // A 2xx to a write means Agility applied it, whatever the body looks like (an operation answers with little or
    // nothing, RESEARCH 1.5): an empty or unreadable body is reported as applied with an unreadable answer, never as an
    // error that would invite a repeat (P7-09, L-404).
    if (call.write && call.expect === 'xml' && (text.trim() === '' || !looksLikeHtml(contentType, text))) {
      try {
        const data = text.trim() === '' ? undefined : parseXml(text);
        if (data !== undefined) return { ok: true, response: { status: res.status, data, bytes } };
      } catch {
        // fall through: unreadable
      }
      return { ok: true, response: { status: res.status, data: EMPTY_XML, bytes, unreadable: true } };
    }
    if (looksLikeHtml(contentType, text)) {
      return { ok: false, retryable: false, error: wrongInstance('an HTML page, often a login page') };
    }
    let data: unknown;
    if (call.expect === 'xml') {
      data = parseXml(text);
    } else {
      try {
        data = JSON.parse(text);
      } catch {
        return { ok: false, retryable: false, error: wrongInstance('the answer was not JSON') };
      }
    }
    const etag = res.headers.get('etag');
    return { ok: true, response: { status: res.status, data, bytes, ...(etag === null ? {} : { etag }) } };
  }
}

const EMPTY_XML: XmlElement = Object.freeze({ name: '', attributes: {}, children: [], text: '' });

/** The Agility client for one tool call. */
export function agilityClient(ctx: ToolContext, options?: AgilityClientOptions): AgilityClient {
  return new AgilityClient(ctx, options);
}
