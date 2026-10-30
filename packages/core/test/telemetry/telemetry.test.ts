// SPDX-License-Identifier: Apache-2.0
// The OTLP/HTTP exporter and the queue in front of it (P8-07, T30): request shape, endpoint and header checks, bounded
// queue, and a collector that fails never reaching the caller of `record`.
import { describe, expect, it } from 'vitest';
import { AbError } from '../../src/errors.ts';
import { createLogger } from '../../src/logger.ts';
import {
  createOtlpExporter,
  createTelemetry,
  type FinishedSpan,
  otlpEndpoint,
  otlpHeaders,
  type SpanExporter,
  type SpanInput,
  telemetryResource,
  traceRequest,
} from '../../src/telemetry/index.ts';

const GOOD_PARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const input = (over: Partial<SpanInput> = {}): SpanInput => ({
  method: 'tools/call',
  kind: 'tool_call',
  tool: 'whoami',
  status: 200,
  refusal: null,
  errorCode: null,
  requestId: '3f2b8a6e-1c1d-4f2a-9d3e-0a1b2c3d4e5f',
  startMs: 1_000,
  endMs: 1_250,
  ...over,
});

function clockAt(t = 1_000) {
  const now = { t };
  return { now, clock: { now: () => now.t } };
}
const random = {
  uuid: () => '00000000-0000-4000-8000-000000000000',
  bytes: (n: number) => new Uint8Array(n).fill(0xab),
};

function setup(over: Partial<Parameters<typeof createTelemetry>[0]> = {}) {
  const exported: FinishedSpan[][] = [];
  const logs: string[] = [];
  const exporter: SpanExporter = {
    export: async (spans) => {
      exported.push([...spans]);
    },
  };
  const { clock, now } = clockAt();
  const telemetry = createTelemetry({
    exporter,
    clock,
    random,
    logger: createLogger({ level: 'debug', sink: (l) => logs.push(l) }),
    knownTools: new Set(['whoami']),
    service: { version: '0.8.0', environment: 'production' },
    ...over,
  });
  return { telemetry, exported, logs, now };
}

describe('traceRequest', () => {
  it('is the OTLP/JSON shape: string nanoseconds, string ints, server kind, error status only for an error', () => {
    const body = traceRequest({ attributes: telemetryResource({ version: '0.8.0', environment: 'test' }) }, [
      {
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        parentSpanId: 'c'.repeat(16),
        name: 'tools/call whoami',
        startMs: 1_700_000_000_123,
        endMs: 1_700_000_000_456,
        error: true,
        attributes: { 'http.response.status_code': 200, 'agility_bridge.fault': 'server' },
      },
      {
        traceId: 'a'.repeat(32),
        spanId: 'd'.repeat(16),
        name: 'ping',
        startMs: 5,
        endMs: 5,
        error: false,
        attributes: {},
      },
    ]) as {
      resourceSpans: Array<{
        resource: { attributes: unknown[] };
        scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>;
      }>;
    };
    const [first, second] = body.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
    expect(first).toMatchObject({
      traceId: 'a'.repeat(32),
      parentSpanId: 'c'.repeat(16),
      kind: 2,
      startTimeUnixNano: '1700000000123000000',
      endTimeUnixNano: '1700000000456000000',
      status: { code: 2 },
    });
    expect(first?.['attributes']).toContainEqual({
      key: 'http.response.status_code',
      value: { intValue: '200' },
    });
    expect(first?.['attributes']).toContainEqual({
      key: 'agility_bridge.fault',
      value: { stringValue: 'server' },
    });
    expect(second?.['status']).toEqual({});
    expect(second).not.toHaveProperty('parentSpanId');
    expect(body.resourceSpans[0]?.resource.attributes).toContainEqual({
      key: 'service.name',
      value: { stringValue: 'agility-bridge' },
    });
  });
});

describe('otlpEndpoint', () => {
  it('accepts https and loopback http, and drops a trailing slash', () => {
    expect(otlpEndpoint('https://collector.example.com')).toBe('https://collector.example.com');
    expect(otlpEndpoint('https://collector.example.com/otlp/')).toBe('https://collector.example.com/otlp');
    expect(otlpEndpoint('http://127.0.0.1:4318')).toBe('http://127.0.0.1:4318');
    expect(otlpEndpoint('http://localhost:4318')).toBe('http://localhost:4318');
  });
  it.each([
    'not a url',
    'http://collector.example.com',
    'ftp://collector.example.com',
    'https://user:pass@collector.example.com',
    'https://collector.example.com?x=1',
    'https://collector.example.com#frag',
    'https://collector.example.com/?',
  ])('refuses %s', (value) => {
    expect(() => otlpEndpoint(value)).toThrow(AbError);
  });
});

describe('otlpHeaders', () => {
  it('parses name=value pairs and lower-cases names', () => {
    expect(otlpHeaders('Authorization=Bearer abc, x-api-key=k=v')).toEqual({
      authorization: 'Bearer abc',
      'x-api-key': 'k=v',
    });
  });
  it.each([
    'noequals',
    '=value',
    'name=',
    'bad name=v',
    'a=b\r\nHost: evil',
    'host=evil.example',
    'content-type=text/plain',
    'content-length=1',
    Array.from({ length: 9 }, (_, i) => `h${i}=v`).join(','),
    `a=${'x'.repeat(3_000)}`,
  ])('refuses %j', (value) => {
    expect(() => otlpHeaders(value)).toThrow(AbError);
  });
});

describe('createOtlpExporter', () => {
  it('posts JSON to <endpoint>/v1/traces with the configured headers and never follows a redirect', async () => {
    const seen: Request[] = [];
    const exporter = createOtlpExporter({
      endpoint: 'https://collector.example.com/otlp',
      headers: { authorization: 'Bearer SECRET-KEY' },
      resource: { attributes: telemetryResource({ version: '0.8.0', environment: 'production' }) },
      fetch: async (r) => {
        seen.push(r);
        return new Response('{}', { status: 200 });
      },
    });
    await exporter.export([
      {
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        name: 'ping',
        startMs: 1,
        endMs: 2,
        error: false,
        attributes: {},
      },
    ]);
    expect(seen).toHaveLength(1);
    const req = seen[0] as Request;
    expect(req.url).toBe('https://collector.example.com/otlp/v1/traces');
    expect(req.method).toBe('POST');
    expect(req.headers.get('content-type')).toBe('application/json');
    expect(req.headers.get('authorization')).toBe('Bearer SECRET-KEY');
    expect(req.redirect).toBe('error');
    // The header values are not part of the body.
    expect(await req.text()).not.toContain('SECRET-KEY');
  });

  it('sends nothing for an empty batch, and throws on a non-2xx answer', async () => {
    let calls = 0;
    const exporter = createOtlpExporter({
      endpoint: 'https://collector.example.com',
      resource: { attributes: {} },
      fetch: async () => {
        calls += 1;
        return new Response('nope', { status: 503 });
      },
    });
    await exporter.export([]);
    expect(calls).toBe(0);
    await expect(
      exporter.export([
        {
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
          name: 'x',
          startMs: 1,
          endMs: 1,
          error: false,
          attributes: {},
        },
      ]),
    ).rejects.toThrow(/503/);
  });

  it('gives up after its timeout', async () => {
    const exporter = createOtlpExporter({
      endpoint: 'https://collector.example.com',
      resource: { attributes: {} },
      timeoutMs: 20,
      fetch: (r) =>
        new Promise((_resolve, reject) => {
          r.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await expect(
      exporter.export([
        {
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
          name: 'x',
          startMs: 1,
          endMs: 1,
          error: false,
          attributes: {},
        },
      ]),
    ).rejects.toThrow(/aborted/);
  });
});

describe('createTelemetry', () => {
  it('queues spans and exports them in a batch when asked, with ids and the span name', async () => {
    const { telemetry, exported } = setup();
    expect(telemetry.record(input())).toBeUndefined();
    expect(telemetry.record(input({ method: 'tools/list', kind: 'list', tool: null }))).toBeUndefined();
    expect(exported).toHaveLength(0);
    await telemetry.flush();
    expect(exported).toHaveLength(1);
    const [a, b] = exported[0] ?? [];
    expect(a?.name).toBe('tools/call whoami');
    expect(b?.name).toBe('tools/list');
    expect(a?.traceId).toBe('ab'.repeat(16));
    expect(a?.spanId).toBe('ab'.repeat(8));
    expect(a?.parentSpanId).toBeUndefined();
    expect(a?.error).toBe(false);
  });

  it('flushes at the batch size and after every span with flushEach', async () => {
    const batch = setup({ batchSize: 3 });
    batch.telemetry.record(input());
    batch.telemetry.record(input());
    const third = batch.telemetry.record(input());
    expect(third).toBeInstanceOf(Promise);
    await third;
    expect(batch.exported.map((b) => b.length)).toEqual([3]);

    const each = setup({ flushEach: true });
    await each.telemetry.record(input());
    await each.telemetry.record(input());
    expect(each.exported.map((b) => b.length)).toEqual([1, 1]);
  });

  it('joins the caller trace only for a valid traceparent, and ignores everything else', async () => {
    const { telemetry, exported } = setup();
    telemetry.record(input({ traceparent: GOOD_PARENT }));
    telemetry.record(input({ traceparent: 'garbage' }));
    telemetry.record(input({ traceparent: null }));
    await telemetry.flush();
    const [joined, bad, none] = exported[0] ?? [];
    expect(joined?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(joined?.parentSpanId).toBe('00f067aa0ba902b7');
    expect(bad?.traceId).toBe('ab'.repeat(16));
    expect(bad?.parentSpanId).toBeUndefined();
    expect(none?.parentSpanId).toBeUndefined();
  });

  it('marks ERROR for server and upstream faults only', async () => {
    const { telemetry, exported } = setup();
    telemetry.record(input({ errorCode: 'AB_INPUT_INVALID' }));
    telemetry.record(input({ errorCode: 'AB_NOT_FOUND' }));
    telemetry.record(input({ errorCode: 'AB_AGILITY_UNAVAILABLE' }));
    telemetry.record(input({ errorCode: 'AB_INTERNAL' }));
    telemetry.record(
      input({ status: 401, refusal: 'no_token', method: 'tools/list', kind: 'list', tool: null }),
    );
    telemetry.record(input({ status: 429, refusal: 'rate_limited' }));
    telemetry.record(input({ status: 503, refusal: 'unavailable' }));
    telemetry.record(input());
    await telemetry.flush();
    expect((exported[0] ?? []).map((s) => s.error)).toEqual([
      false,
      false,
      true,
      true,
      false,
      false,
      true,
      false,
    ]);
  });

  it('keeps the queue bounded and counts what it dropped', async () => {
    const { telemetry, exported } = setup({ maxQueue: 5, batchSize: 1_000 });
    for (let i = 0; i < 12; i++) telemetry.record(input({ startMs: i, endMs: i }));
    expect(telemetry.stats().dropped).toBe(7);
    await telemetry.flush();
    // The newest five are kept.
    expect((exported[0] ?? []).map((s) => s.startMs)).toEqual([7, 8, 9, 10, 11]);
  });

  it('never throws into the request when the collector fails, and logs the class only, at most once a minute', async () => {
    const logs: string[] = [];
    const { clock, now } = clockAt();
    const telemetry = createTelemetry({
      exporter: {
        export: async () => {
          throw new Error('https://collector.example.com/v1/traces?key=SECRET-KEY refused');
        },
      },
      clock,
      random,
      logger: createLogger({ level: 'debug', sink: (l) => logs.push(l) }),
      knownTools: new Set(['whoami']),
      service: { version: '0.8.0', environment: 'production' },
      flushEach: true,
    });
    await expect(telemetry.record(input())).resolves.toBeUndefined();
    await expect(telemetry.record(input())).resolves.toBeUndefined();
    expect(telemetry.stats().failedBatches).toBe(2);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('telemetry export failed');
    expect(logs[0]).toContain('Error');
    expect(logs.join('')).not.toContain('SECRET-KEY');
    expect(logs.join('')).not.toContain('collector.example.com');
    now.t += 61_000;
    await telemetry.record(input());
    expect(logs).toHaveLength(2);
  });

  it('exports nothing but allowlisted attributes, whatever the facts carry', async () => {
    const { telemetry, exported } = setup();
    telemetry.record({
      ...input({ tool: 'whoami' }),
      // Extra fields a careless caller might pass; the type forbids them, the code ignores them.
      ...({
        workspace: 'team-a',
        user: 'alice@example.test',
        args: { asset: 'B-01234' },
        message: 'Salary review',
      } as object),
    });
    await telemetry.flush();
    const attrs = (exported[0] ?? [])[0]?.attributes ?? {};
    expect(JSON.stringify(attrs)).not.toMatch(/team-a|alice|B-01234|Salary/);
    expect(Object.keys(attrs).sort()).toEqual(
      [
        'agility_bridge.fault',
        'agility_bridge.method_class',
        'agility_bridge.outcome',
        'agility_bridge.request_id',
        'gen_ai.tool.name',
        'http.response.status_code',
        'mcp.method.name',
      ].sort(),
    );
  });
});
