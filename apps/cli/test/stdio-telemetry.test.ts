// SPDX-License-Identifier: Apache-2.0
// The stdio span tracker (P8-20, THREAT_MODEL T30, L-118, L-119): what it reads from a frame, how it classifies the answer.
import { createTelemetry, ERROR_META_KEY, type FinishedSpan, silentLogger } from '@agility-bridge/core';
import { describe, expect, it } from 'vitest';
import { StdioSpanTracker, stdioTelemetry } from '../src/stdio-telemetry.ts';

const clock = { now: () => 1_000 };
const random = {
  uuid: () => '11111111-2222-3333-4444-555555555555',
  bytes: (n: number) => new Uint8Array(n).fill(7),
};

function rig(maxQueue = 512) {
  const spans: FinishedSpan[] = [];
  const telemetry = createTelemetry({
    exporter: {
      export: async (batch) => {
        spans.push(...batch);
      },
    },
    clock,
    random,
    logger: silentLogger,
    knownTools: new Set(['whoami', 'get_work_item']),
    service: { version: '1.0.0', environment: 'production' },
    maxQueue,
  });
  return { spans, telemetry, tracker: new StdioSpanTracker(telemetry, clock, random) };
}

const attrs = (s: FinishedSpan) => s.attributes as Record<string, string | number>;

describe('StdioSpanTracker', () => {
  it('makes one span per request from the answer, and one per notification', async () => {
    const { spans, telemetry, tracker } = rig();
    tracker.inbound({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    tracker.inbound({ jsonrpc: '2.0', method: 'notifications/initialized' });
    tracker.outbound({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    // A server request of ours and the answer to it from the client are not tracked as a request of the client.
    tracker.outbound({ jsonrpc: '2.0', id: 9, method: 'elicitation/create', params: {} });
    await telemetry.flush();
    expect(spans.map((s) => s.name)).toEqual(['notifications/initialized', 'tools/list']);
    expect(attrs(spans[1] as FinishedSpan)).toMatchObject({
      'mcp.method.name': 'tools/list',
      'agility_bridge.method_class': 'list',
      'agility_bridge.outcome': 'ok',
      'http.response.status_code': 200,
    });
  });

  it('classifies a failed tool call by the code in its result, never by its text', async () => {
    const { spans, telemetry, tracker } = rig();
    tracker.inbound({
      jsonrpc: '2.0',
      id: 'a',
      method: 'tools/call',
      params: { name: 'get_work_item', arguments: { number: 'B-01001', note: 'private text' } },
    });
    tracker.outbound({
      jsonrpc: '2.0',
      id: 'a',
      result: {
        isError: true,
        content: [{ type: 'text', text: 'Agility says: confidential title' }],
        _meta: { [ERROR_META_KEY]: { code: 'AB_AGILITY_UNAVAILABLE' } },
      },
    });
    tracker.inbound({ jsonrpc: '2.0', id: 'b', method: 'tools/call', params: { name: 'get_work_item' } });
    tracker.outbound({
      jsonrpc: '2.0',
      id: 'b',
      result: { isError: true, content: [], _meta: { [ERROR_META_KEY]: { code: 'AB_INPUT_INVALID' } } },
    });
    await telemetry.flush();
    const [upstream, caller] = spans as [FinishedSpan, FinishedSpan];
    expect(attrs(upstream)).toMatchObject({
      'gen_ai.tool.name': 'get_work_item',
      'agility_bridge.fault': 'upstream',
      'error.type': 'AB_AGILITY_UNAVAILABLE',
    });
    expect(upstream.error).toBe(true);
    expect(attrs(caller)['agility_bridge.fault']).toBe('caller');
    expect(caller.error).toBe(false);
    expect(JSON.stringify(spans)).not.toMatch(/private text|confidential|B-01001/);
  });

  it('names an unregistered tool "unknown" and keeps only allowlisted attributes', async () => {
    const { spans, telemetry, tracker } = rig();
    tracker.inbound({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'Robert); DROP' } });
    tracker.outbound({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Unknown tool: Robert' } });
    tracker.inbound({ jsonrpc: '2.0', id: 2, method: 'x/secret-method' });
    tracker.outbound({ jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'boom' } });
    await telemetry.flush();
    const [first, second] = spans as [FinishedSpan, FinishedSpan];
    expect(attrs(first)).toMatchObject({
      'gen_ai.tool.name': 'unknown',
      'agility_bridge.outcome': 'refused',
      'http.response.status_code': 400,
    });
    expect(attrs(second)).toMatchObject({
      'mcp.method.name': 'other',
      'agility_bridge.fault': 'server',
      'http.response.status_code': 500,
    });
    expect(JSON.stringify(spans)).not.toMatch(/Robert|secret-method|boom/);
  });

  it('keeps a bounded number of requests that never get an answer', async () => {
    const { spans, telemetry, tracker } = rig();
    for (let i = 0; i < 1_000; i++) tracker.inbound({ jsonrpc: '2.0', id: i, method: 'ping' });
    tracker.outbound({ jsonrpc: '2.0', id: 0, result: {} });
    tracker.outbound({ jsonrpc: '2.0', id: 999, result: {} });
    await telemetry.flush();
    // The oldest were forgotten: id 0 has no span, the newest has one.
    expect(spans).toHaveLength(1);
  });

  it('never throws on garbage', () => {
    const { tracker } = rig();
    for (const junk of [null, undefined, 5, 'x', [], { id: {} }, { id: 1n }]) {
      expect(() => tracker.inbound(junk)).not.toThrow();
      expect(() => tracker.outbound(junk)).not.toThrow();
    }
  });
});

describe('stdioTelemetry', () => {
  const deps = { version: '1.0.0', logger: silentLogger, clock, random };

  it('is off without an endpoint, and refuses headers without one', () => {
    expect(stdioTelemetry({}, deps)).toBeUndefined();
    expect(stdioTelemetry({ AB_OTEL_ENDPOINT: '' }, deps)).toBeUndefined();
    expect(() => stdioTelemetry({ AB_OTEL_HEADERS: 'k=v' }, deps)).toThrow(
      /AB_OTEL_HEADERS needs AB_OTEL_ENDPOINT/,
    );
  });

  it('sends to the endpoint with its headers, and a failing collector never throws', async () => {
    const seen: Array<{ url: string; key: string | null }> = [];
    let fail = false;
    const monitoring = stdioTelemetry(
      { AB_OTEL_ENDPOINT: 'https://collector.example/otlp', AB_OTEL_HEADERS: 'x-api-key=abc' },
      {
        ...deps,
        fetch: async (request) => {
          seen.push({ url: request.url, key: request.headers.get('x-api-key') });
          if (fail) throw new TypeError('connection refused');
          return new Response('{}');
        },
      },
    );
    expect(monitoring?.host).toBe('collector.example');
    const tracker = new StdioSpanTracker(
      (monitoring as NonNullable<typeof monitoring>).telemetry,
      clock,
      random,
    );
    tracker.inbound({ jsonrpc: '2.0', id: 1, method: 'ping' });
    tracker.outbound({ jsonrpc: '2.0', id: 1, result: {} });
    await monitoring?.stop();
    expect(seen).toEqual([{ url: 'https://collector.example/otlp/v1/traces', key: 'abc' }]);
    fail = true;
    tracker.inbound({ jsonrpc: '2.0', id: 2, method: 'ping' });
    tracker.outbound({ jsonrpc: '2.0', id: 2, result: {} });
    await expect(monitoring?.stop()).resolves.toBeUndefined();
    expect((monitoring?.telemetry.stats() ?? { failedBatches: 0 }).failedBatches).toBe(1);
  });
});
