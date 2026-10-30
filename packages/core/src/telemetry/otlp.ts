// SPDX-License-Identifier: Apache-2.0
// OTLP/HTTP (JSON) export of finished spans (P8-07). No SDK: one `fetch` to `<endpoint>/v1/traces`. The exporter sees only
// `FinishedSpan`s, whose attributes were sanitised, and never throws into a request.
import { AbError, ErrorCode } from '../errors.ts';
import type { Attributes, AttributeValue } from './attributes.ts';

export interface FinishedSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string | undefined;
  readonly name: string;
  readonly startMs: number;
  readonly endMs: number;
  /** `ERROR` only for a service fault (server or upstream); caller faults leave the status unset (L-118). */
  readonly error: boolean;
  readonly attributes: Attributes;
}

export interface OtlpResource {
  readonly attributes: Attributes;
}

/** An OTLP attribute value (`AnyValue`): ints are strings in the JSON mapping. */
function anyValue(v: AttributeValue): Record<string, unknown> {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
}

function keyValues(attrs: Attributes): Array<{ key: string; value: Record<string, unknown> }> {
  return Object.entries(attrs).map(([key, value]) => ({ key, value: anyValue(value) }));
}

/** Nanoseconds since the epoch as the decimal string OTLP/JSON wants. */
function nanos(ms: number): string {
  return (BigInt(Math.max(0, Math.trunc(ms))) * 1_000_000n).toString();
}

const SPAN_KIND_SERVER = 2;
const STATUS_ERROR = 2;

/** The `ExportTraceServiceRequest` body for `spans`. */
export function traceRequest(
  resource: OtlpResource,
  spans: readonly FinishedSpan[],
): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: { attributes: keyValues(resource.attributes) },
        scopeSpans: [
          {
            scope: { name: 'agility-bridge' },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId === undefined ? {} : { parentSpanId: s.parentSpanId }),
              name: s.name,
              kind: SPAN_KIND_SERVER,
              startTimeUnixNano: nanos(s.startMs),
              endTimeUnixNano: nanos(Math.max(s.startMs, s.endMs)),
              attributes: keyValues(s.attributes),
              status: s.error ? { code: STATUS_ERROR } : {},
            })),
          },
        ],
      },
    ],
  };
}

export interface SpanExporter {
  export(spans: readonly FinishedSpan[]): Promise<void>;
}

export interface OtlpExporterOptions {
  /** The collector's base URL: `<endpoint>/v1/traces` is posted to. Validated by `otlpEndpoint`. */
  readonly endpoint: string;
  /** Extra request headers (an API key for a hosted collector): secret, never logged. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly resource: OtlpResource;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly timeoutMs?: number;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A collector base URL, checked at configuration time: HTTPS (plain HTTP only for loopback, for a collector next to the
 * server), no user info, query or fragment. The result has no trailing slash.
 */
export function otlpEndpoint(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new AbError(ErrorCode.InputInvalid, 'The OpenTelemetry endpoint is not a valid URL.');
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp)
    throw new AbError(
      ErrorCode.InputInvalid,
      'The OpenTelemetry endpoint must use https:// (http only on loopback).',
    );
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    /[?#]/.test(input)
  )
    throw new AbError(
      ErrorCode.InputInvalid,
      'The OpenTelemetry endpoint must not contain a user name, password, query or fragment.',
    );
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const hasControl = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/** Parses `name=value,name2=value2` (an API key header for a collector). Names are HTTP tokens, values have no control characters. */
export function otlpHeaders(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  const bad = () =>
    new AbError(
      ErrorCode.InputInvalid,
      'The OpenTelemetry headers must be name=value pairs separated by commas.',
    );
  const pairs = input.split(',').filter((p) => p.trim() !== '');
  if (pairs.length > 8 || input.length > 2_048) throw bad();
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at < 1) throw bad();
    const name = pair.slice(0, at).trim().toLowerCase();
    const value = pair.slice(at + 1).trim();
    // Never let a setting override what the exporter itself sets or what makes the request something else.
    if (!/^[a-z0-9-]{1,64}$/.test(name) || hasControl(value) || value === '') throw bad();
    if (['host', 'content-type', 'content-length', 'transfer-encoding', 'connection'].includes(name))
      throw bad();
    out[name] = value;
  }
  return out;
}

/** Posts spans to an OTLP/HTTP collector. One attempt, a short timeout; any failure is thrown for the caller to count. */
export function createOtlpExporter(options: OtlpExporterOptions): SpanExporter {
  const send = options.fetch ?? ((request: Request) => fetch(request));
  const timeoutMs = options.timeoutMs ?? 3_000;
  const url = `${options.endpoint}/v1/traces`;
  return {
    async export(spans) {
      if (spans.length === 0) return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await send(
          new Request(url, {
            method: 'POST',
            headers: { ...options.headers, 'content-type': 'application/json' },
            body: JSON.stringify(traceRequest(options.resource, spans)),
            redirect: 'manual',
            signal: controller.signal,
          }),
        );
        // Drain so the connection can be reused; the body is the collector's and is never read for its content.
        await response.body?.cancel().catch(() => {});
        if (!response.ok) throw new Error(`collector answered ${response.status}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
