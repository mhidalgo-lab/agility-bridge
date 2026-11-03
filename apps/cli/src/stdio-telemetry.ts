// SPDX-License-Identifier: Apache-2.0
// Self-monitoring for the stdio server (P8-20, THREAT_MODEL T30): the same `Telemetry` the HTTP hosts use, behind the
// transport instead of an HTTP route. Every JSON-RPC request the client sends and the answer the server writes become one
// span with the HTTP attribute list and nothing else (L-119); a failed tool call carries its stable `AB_*` code (L-118).
// A collector that is down costs nothing here: spans are queued and exported on a timer, a failure is one line on stderr
// (never the endpoint or a header), and stdout carries MCP frames only (L-021).
import {
  AbError,
  type Clock,
  CORE_TOOLS,
  createOtlpExporter,
  createTelemetry,
  ERROR_META_KEY,
  ErrorCode,
  flushPeriodically,
  type Logger,
  otlpEndpoint,
  otlpHeaders,
  type Random,
  type Telemetry,
  telemetryResource,
} from '@agility-bridge/core';
import { classifyMcpMessage } from '@agility-bridge/http-app';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { ConfigError } from './config.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface StdioTelemetry {
  readonly telemetry: Telemetry;
  /** The collector's host, for the start-up line (never the path, a header or a value). */
  readonly host: string;
  /** Stops the timer and sends what is queued. Never throws. */
  stop(): Promise<void>;
}

/**
 * `AB_OTEL_ENDPOINT` and `AB_OTEL_HEADERS` for the stdio server, read like the remote hosts read them. A bad value stops
 * start-up and names the variable, never the value (the headers are a secret). Undefined when no endpoint is set.
 */
export function stdioTelemetry(
  env: Env,
  options: {
    readonly version: string;
    readonly logger: Logger;
    readonly clock: Clock;
    readonly random: Random;
    readonly fetch?: (request: Request) => Promise<Response>;
  },
): StdioTelemetry | undefined {
  const endpoint = env['AB_OTEL_ENDPOINT'];
  const headers = env['AB_OTEL_HEADERS'];
  if (endpoint === undefined || endpoint === '') {
    if (headers !== undefined && headers !== '')
      throw new ConfigError('AB_OTEL_HEADERS needs AB_OTEL_ENDPOINT.');
    return undefined;
  }
  let url: string;
  let parsedHeaders: Record<string, string> | undefined;
  try {
    url = otlpEndpoint(endpoint);
    parsedHeaders = headers === undefined || headers === '' ? undefined : otlpHeaders(headers);
  } catch (error) {
    if (!(error instanceof AbError) || error.code !== ErrorCode.InputInvalid) throw error;
    const name = error.message.includes('headers') ? 'AB_OTEL_HEADERS' : 'AB_OTEL_ENDPOINT';
    throw new ConfigError(`${name} is invalid: ${error.message}`);
  }
  const service = { version: options.version, environment: 'production' } as const;
  const telemetry = createTelemetry({
    exporter: createOtlpExporter({
      endpoint: url,
      ...(parsedHeaders === undefined ? {} : { headers: parsedHeaders }),
      resource: { attributes: telemetryResource(service) },
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
    clock: options.clock,
    random: options.random,
    logger: options.logger,
    knownTools: new Set(CORE_TOOLS.map((t) => t.name)),
    service,
  });
  const stopTimer = flushPeriodically(telemetry);
  return {
    telemetry,
    host: new URL(url).host,
    async stop() {
      stopTimer();
      await telemetry.flush();
    },
  };
}

/** A JSON-RPC message as far as the tracker reads it; everything else in it is ignored. */
interface Frame {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown } | undefined;
}

interface Pending {
  readonly method: string | null;
  readonly kind: string;
  readonly tool: string | null;
  readonly startMs: number;
}

/** In-flight requests kept at most; a client that never gets answers cannot grow this without bound. */
const MAX_PENDING = 256;

/** The HTTP-shaped status of a JSON-RPC answer: a result is 200, a malformed or unknown request 400, our own failure 500. */
function statusOf(frame: Frame): number {
  if (frame.error === undefined) return 200;
  const code = frame.error.code;
  return code === -32600 || code === -32601 || code === -32602 || code === -32700 ? 400 : 500;
}

/** The `AB_*` code of a failed tool call, from the result's own metadata, or null. */
function toolErrorCode(frame: Frame): string | null {
  const result = frame.result as { isError?: unknown; _meta?: Record<string, unknown> } | undefined;
  if (result?.isError !== true) return null;
  const code = (result._meta?.[ERROR_META_KEY] as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : 'AB_INTERNAL';
}

/**
 * Pairs each client request with the server's answer and records one span per exchange (one per notification). Reads only
 * the method, the tool name, the id and the error code of a frame, through `classifyMcpMessage` (bounded, never the
 * arguments, the result's text or a header), and `Telemetry` sanitises the rest again. Never throws.
 */
export class StdioSpanTracker {
  readonly #pending = new Map<string | number, Pending>();
  readonly #telemetry: Telemetry;
  readonly #clock: Clock;
  readonly #random: Random;

  constructor(telemetry: Telemetry, clock: Clock, random: Random) {
    this.#telemetry = telemetry;
    this.#clock = clock;
    this.#random = random;
  }

  /** A frame from the client. */
  inbound(message: unknown): void {
    try {
      const frame = message as Frame;
      const classified = classifyMcpMessage(message);
      const now = this.#clock.now();
      const hasId = typeof frame.id === 'string' || typeof frame.id === 'number';
      if (classified.method !== null && hasId) {
        if (this.#pending.size >= MAX_PENDING) {
          const oldest = this.#pending.keys().next();
          if (oldest.done !== true) this.#pending.delete(oldest.value);
        }
        this.#pending.set(frame.id as string | number, {
          method: classified.method,
          kind: classified.kind,
          tool: classified.tool,
          startMs: now,
        });
        return;
      }
      // A notification, or the client's answer to a request of ours: nothing follows, so the span is complete now.
      this.#record({ ...classified, startMs: now }, 202, null, now);
    } catch {
      // Observing never changes what the server does.
    }
  }

  /** A frame the server writes: an answer closes the span of its request. Requests and notifications of ours are not spans. */
  outbound(message: unknown): void {
    try {
      const frame = message as Frame;
      if (frame.method !== undefined) return;
      if (typeof frame.id !== 'string' && typeof frame.id !== 'number') return;
      const pending = this.#pending.get(frame.id);
      if (pending === undefined) return;
      this.#pending.delete(frame.id);
      this.#record(pending, statusOf(frame), toolErrorCode(frame), this.#clock.now());
    } catch {
      // Observing never changes what the server does.
    }
  }

  #record(
    facts: Pending | (ReturnType<typeof classifyMcpMessage> & { startMs: number }),
    status: number,
    errorCode: string | null,
    endMs: number,
  ): void {
    const work = this.#telemetry.record({
      method: facts.method,
      kind: facts.kind,
      tool: facts.tool,
      status,
      refusal: null,
      errorCode,
      requestId: this.#random.uuid(),
      startMs: facts.startMs,
      endMs,
    });
    // A flush started by a full queue never rejects (the exporter's failure is counted); do not wait for it.
    void work;
  }
}

/**
 * The real stdio transport with a tracker on both directions. The frames pass through unchanged and in the same order; the
 * observer runs before the frame moves and cannot throw into it.
 */
export class ObservedStdioTransport extends StdioServerTransport {
  constructor(tracker: StdioSpanTracker, onClosed: () => void) {
    super();
    let inner: StdioServerTransport['onmessage'];
    let closed: StdioServerTransport['onclose'];
    Object.defineProperty(this, 'onmessage', {
      configurable: true,
      get: () => inner,
      set: (handler: StdioServerTransport['onmessage']) => {
        inner =
          handler === undefined
            ? undefined
            : (message) => {
                tracker.inbound(message);
                handler(message);
              };
      },
    });
    Object.defineProperty(this, 'onclose', {
      configurable: true,
      get: () => closed,
      set: (handler: StdioServerTransport['onclose']) => {
        closed = () => {
          try {
            onClosed();
          } catch {
            // The last flush is best effort.
          }
          handler?.();
        };
      },
    });
    this.#tracker = tracker;
  }

  readonly #tracker: StdioSpanTracker;

  override send(...args: Parameters<StdioServerTransport['send']>): Promise<void> {
    this.#tracker.outbound(args[0]);
    return super.send(...args);
  }
}
