// SPDX-License-Identifier: Apache-2.0
// Self-monitoring (P8-07, THREAT_MODEL T30): one span per finished MCP request, exported over OTLP/HTTP when an operator
// turned it on. The queue holds only sanitised spans (our own vocabulary and numbers, never request data), so sharing it
// between requests of one process is not the module state T21 forbids. On Workers spans are batched per isolate (P8-43):
// plain data only is queued, and every flush (size, bytes or age) runs in the `waitUntil` of the request that triggered it.
import type { Clock, Random } from '../context.ts';
import type { Logger } from '../logger.ts';
import {
  type Attributes,
  classify,
  isServiceError,
  type SpanFacts,
  sanitizeResource,
  spanAttributes,
} from './attributes.ts';
import type { FinishedSpan, SpanExporter } from './otlp.ts';
import { hex, parseTraceparent } from './trace-context.ts';

/** What the host passes when an MCP request ends. */
export interface SpanInput extends SpanFacts {
  readonly startMs: number;
  readonly endMs: number;
  /** The raw `traceparent` header, only when the request was authenticated; the caller of `record` decides, we never see a token. */
  readonly traceparent?: string | null | undefined;
  /**
   * The request never authenticated (a 401, a 429 from the IP limiter, the public catalogue). Such spans are sampled by a
   * per-minute budget so unauthenticated traffic cannot set the volume of the collector's bill or of subrequests (P-3).
   */
  readonly unauthenticated?: boolean;
}

export interface Telemetry {
  /**
   * Records one finished request. Never throws. Returns the flush it started (to keep alive after the response on Workers),
   * or undefined when the span only joined the queue.
   */
  record(input: SpanInput): Promise<void> | undefined;
  /** Sends what is queued. Never throws. */
  flush(): Promise<void>;
  /** Spans dropped (full queue) and batches that failed to export, since start: for the operator's own health line. */
  readonly stats: () => {
    readonly dropped: number;
    readonly failedBatches: number;
    /** Unauthenticated spans not recorded because the minute's budget was used. */
    readonly sampledOut: number;
  };
}

export interface TelemetryOptions {
  readonly exporter: SpanExporter;
  readonly clock: Clock;
  readonly random: Random;
  readonly logger: Logger;
  /** Registered tool names: a `tools/call` span names its tool only if it is one of these. */
  readonly knownTools: ReadonlySet<string>;
  readonly service: { readonly version: string; readonly environment: 'production' | 'test' };
  /** Flush after every span (Workers, where nothing in flight is shared between requests, L-096). Default false. */
  readonly flushEach?: boolean;
  /** Spans kept at most; the oldest are dropped past it. Default 512. */
  readonly maxQueue?: number;
  /** Estimated bytes kept at most (the sum of `estimateSpanBytes`); the oldest are dropped past it. Default 262,144. */
  readonly maxQueueBytes?: number;
  /**
   * Age flush for hosts without a timer of their own (Workers, P8-43). When set, the span that finds no flush pending
   * returns a promise that waits `maxAgeMs` and then flushes, for the caller to hand to its own `waitUntil`: the wait and the
   * flush belong to that one request and nothing but plain spans is shared. Without it the host flushes on a timer (Node).
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /** With `sleep`: the longest a queued span waits for a size flush. Default 5,000 ms. */
  readonly maxAgeMs?: number;
  /** Exports in flight at once in this process or isolate; a full flush is left in the queue (and bounded there). Default 4. */
  readonly maxInFlight?: number;
  /** Flush when this many are queued. Default 64. */
  readonly batchSize?: number;
  /** Unauthenticated spans recorded per minute and process or isolate; the rest are counted, not exported. Default 30. */
  readonly unauthenticatedPerMinute?: number;
}

/** The resource attributes of every exported batch. */
export function telemetryResource(service: TelemetryOptions['service']): Attributes {
  return sanitizeResource({
    'service.name': 'agility-bridge',
    'service.version': service.version,
    'deployment.environment.name': service.environment,
  });
}

/** A cheap upper-ish estimate of a span's size on the wire: its text and a fixed share for ids, times and framing. */
export function estimateSpanBytes(span: FinishedSpan): number {
  let bytes = 160 + span.name.length;
  for (const [key, value] of Object.entries(span.attributes)) {
    bytes += 40 + key.length + (typeof value === 'string' ? value.length : 8);
  }
  return bytes;
}

/** `tools/call get_sprint`: the span name is a known method plus a registered tool, nothing the caller typed. */
function spanName(attrs: Attributes): string {
  const method = String(attrs['mcp.method.name'] ?? 'other');
  const tool = attrs['gen_ai.tool.name'];
  return typeof tool === 'string' ? `${method} ${tool}` : method;
}

export function createTelemetry(options: TelemetryOptions): Telemetry {
  const maxQueue = options.maxQueue ?? 512;
  const batchSize = options.batchSize ?? 64;
  const maxBytes = options.maxQueueBytes ?? 262_144;
  const maxAgeMs = options.maxAgeMs ?? 5_000;
  const maxInFlight = options.maxInFlight ?? 4;
  let queue: FinishedSpan[] = [];
  let queueBytes = 0;
  let inFlight = 0;
  /** When the age flush now pending was armed; a flush whose request was cut short is replaced after twice the age. */
  let armedAt = Number.NEGATIVE_INFINITY;
  let dropped = 0;
  let failedBatches = 0;
  let sampledOut = 0;
  let minute = Number.NEGATIVE_INFINITY;
  let minuteSpent = 0;
  const unauthenticatedBudget = options.unauthenticatedPerMinute ?? 30;
  let warnedAt = Number.NEGATIVE_INFINITY;

  const flush = async (): Promise<void> => {
    if (queue.length === 0 || inFlight >= maxInFlight) return;
    const batch = queue;
    queue = [];
    queueBytes = 0;
    inFlight += 1;
    try {
      await options.exporter.export(batch);
    } catch (error) {
      failedBatches += 1;
      // The class of the failure only: never the endpoint, a header or a message that could carry either.
      const now = options.clock.now();
      if (now - warnedAt > 60_000) {
        warnedAt = now;
        options.logger.warn('telemetry export failed', {
          error: error instanceof Error ? error.name : typeof error,
          spans: batch.length,
        });
      }
    } finally {
      inFlight -= 1;
    }
  };

  const ageFlush = async (sleep: (ms: number) => Promise<void>): Promise<void> => {
    try {
      await sleep(maxAgeMs);
    } catch {
      // A timer that fails still lets the queue flush below.
    }
    armedAt = Number.NEGATIVE_INFINITY;
    await flush();
  };

  return {
    record(input) {
      try {
        if (input.unauthenticated === true) {
          const now = Math.floor(options.clock.now() / 60_000);
          if (now !== minute) {
            minute = now;
            minuteSpent = 0;
          }
          if (minuteSpent >= unauthenticatedBudget) {
            sampledOut += 1;
            return undefined;
          }
          minuteSpent += 1;
        }
        const attributes = spanAttributes(input, options.knownTools);
        const parent = parseTraceparent(input.traceparent);
        const span: FinishedSpan = {
          traceId: parent?.traceId ?? hex(options.random.bytes(16)),
          spanId: hex(options.random.bytes(8)),
          ...(parent === undefined ? {} : { parentSpanId: parent.parentSpanId }),
          name: spanName(attributes),
          startMs: input.startMs,
          endMs: input.endMs,
          error: isServiceError(classify(input).fault),
          attributes,
        };
        queue.push(span);
        queueBytes += estimateSpanBytes(span);
        // Bounded in count and in bytes: the oldest go first, and each is counted.
        let over = Math.max(0, queue.length - maxQueue);
        let kept = queueBytes;
        for (let i = 0; i < over; i++) kept -= estimateSpanBytes(queue[i] as FinishedSpan);
        while (kept > maxBytes && over < queue.length - 1) {
          kept -= estimateSpanBytes(queue[over] as FinishedSpan);
          over += 1;
        }
        if (over > 0) {
          dropped += over;
          queue = queue.slice(over);
        }
        queueBytes = kept;
        if (options.flushEach === true || queue.length >= batchSize || queueBytes >= maxBytes / 2)
          return flush();
        const sleep = options.sleep;
        if (sleep !== undefined) {
          const now = options.clock.now();
          if (now - armedAt > maxAgeMs * 2) {
            armedAt = now;
            return ageFlush(sleep);
          }
        }
        return undefined;
      } catch {
        // A span that cannot be built is not worth a failed request.
        dropped += 1;
        return undefined;
      }
    },
    flush,
    stats: () => ({ dropped, failedBatches, sampledOut }),
  };
}

/** Flushes every `ms` until stopped (Node). The timer never keeps the process alive. */
export function flushPeriodically(telemetry: Telemetry, ms = 5_000): () => void {
  const timer = setInterval(() => void telemetry.flush(), ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
