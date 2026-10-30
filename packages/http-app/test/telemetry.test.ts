// SPDX-License-Identifier: Apache-2.0
// Self-monitoring end to end (P8-07, THREAT_MODEL T30): the HTTP app with telemetry on, a real local HTTP server standing in
// for the OTLP collector (no external service), and what it received. Error-rate semantics, every method, the attribute
// allowlist on a full run, strict `traceparent`, and a collector that is down, slow or failing.
import {
  CORE_TOOLS,
  createOtlpExporter,
  createTelemetry,
  defineTool,
  type Telemetry,
  telemetryResource,
} from '@agility-bridge/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseServerSettings, SERVER_SETTING_NAMES, SettingsError, settingWarnings } from '../src/index.ts';
import { ALICE_AGILITY, ORIGIN, post, TOOL_INFO, type World, world } from './helpers/world.ts';

interface Received {
  readonly path: string;
  readonly headers: Headers;
  readonly body: string;
}
interface Collector {
  /** The `fetch` the exporter posts with: a stand-in for the network, answering like an OTLP/HTTP collector. */
  readonly fetch: (request: Request) => Promise<Response>;
  readonly received: Received[];
  /** Every span received, attributes as a plain object. */
  spans(): DecodedSpan[];
}
interface DecodedSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly statusCode: number;
  readonly attrs: Record<string, string | number | boolean>;
}

/**
 * A local fake OTLP collector (no network, no external service): records every POST and answers as `respond` says
 * (200 by default; a held promise is a collector that has not answered yet; a throw is one that is gone). A real HTTP
 * server version of this runs in `apps/cli/test/telemetry.e2e.test.ts` against `agility-bridge serve`.
 */
function collector(
  respond: (n: number) => { status: number; hold?: Promise<void> } | 'gone' = () => ({ status: 200 }),
): Collector {
  const received: Received[] = [];
  const attr = (a: { key: string; value: Record<string, string> }): [string, string | number | boolean] => {
    const v = a.value;
    return [
      a.key,
      v['stringValue'] ?? (v['intValue'] !== undefined ? Number(v['intValue']) : (v['boolValue'] as never)),
    ];
  };
  return {
    received,
    fetch: async (request) => {
      received.push({
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: await request.text(),
      });
      const plan = respond(received.length);
      if (plan === 'gone') throw new TypeError('fetch failed');
      if (plan.hold !== undefined) await plan.hold;
      return new Response('{}', { status: plan.status, headers: { 'content-type': 'application/json' } });
    },
    spans() {
      return received.flatMap((r) => {
        const body = JSON.parse(r.body) as {
          resourceSpans: Array<{
            scopeSpans: Array<{
              spans: Array<{
                name: string;
                traceId: string;
                spanId: string;
                parentSpanId?: string;
                status: { code?: number };
                attributes: Array<{ key: string; value: Record<string, string> }>;
              }>;
            }>;
          }>;
        };
        return body.resourceSpans.flatMap((rs) =>
          rs.scopeSpans.flatMap((ss) =>
            ss.spans.map((sp) => ({
              name: sp.name,
              traceId: sp.traceId,
              spanId: sp.spanId,
              ...(sp.parentSpanId === undefined ? {} : { parentSpanId: sp.parentSpanId }),
              statusCode: sp.status.code ?? 0,
              attrs: Object.fromEntries(sp.attributes.map(attr)),
            })),
          ),
        );
      });
    },
  };
}

function telemetryFor(
  c: Collector,
  over: { timeoutMs?: number; flushEach?: boolean; unauthenticatedPerMinute?: number } = {},
): Telemetry {
  const logs: string[] = [];
  return createTelemetry({
    exporter: createOtlpExporter({
      endpoint: 'https://collector.example.com',
      fetch: c.fetch,
      headers: { authorization: 'Bearer COLLECTOR-KEY' },
      resource: { attributes: telemetryResource({ version: '0.0.0-test', environment: 'test' }) },
      ...(over.timeoutMs === undefined ? {} : { timeoutMs: over.timeoutMs }),
    }),
    clock: { now: () => Date.now() },
    random: { uuid: () => crypto.randomUUID(), bytes: (n) => crypto.getRandomValues(new Uint8Array(n)) },
    logger: {
      debug: () => {},
      info: () => {},
      warn: (m) => logs.push(m),
      error: () => {},
      child: () => telemetryLogger,
    },
    knownTools: new Set(CORE_TOOLS.map((t) => t.name)),
    service: { version: '0.0.0-test', environment: 'test' },
    flushEach: over.flushEach ?? false,
    ...(over.unauthenticatedPerMinute === undefined
      ? {}
      : { unauthenticatedPerMinute: over.unauthenticatedPerMinute }),
  });
}
const telemetryLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => telemetryLogger,
};

/** One call, with the answer read to its end (a streamed answer ends the span). */
async function call(
  w: World,
  slug: string,
  token: string | null,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const res = await post(w, slug, token, body, headers);
  const text = await res.text();
  return { res, text };
}
const rpc = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id, method, params });

describe('a flood of unauthenticated requests (P-3)', () => {
  it('sends a bounded number of spans (and collector requests), the rest only counted; authenticated ones are all kept', async () => {
    const c = collector();
    const telemetry = telemetryFor(c, { flushEach: true, unauthenticatedPerMinute: 3 });
    const w = await world({ telemetry });
    for (let i = 0; i < 12; i++) {
      expect((await call(w, 'team-a', null, rpc(i, 'tools/list'))).res.status).toBe(401);
    }
    await telemetry.flush();
    expect(c.spans()).toHaveLength(3);
    expect(telemetry.stats().sampledOut).toBe(9);
    await call(w, 'team-a', w.tokens.alice, rpc(99, 'ping'));
    await telemetry.flush();
    expect(c.spans()).toHaveLength(4);
  });
});

describe('every MCP method and every early refusal is one span', () => {
  it('names the method and class, whatever the answer', async () => {
    const c = collector();
    const telemetry = telemetryFor(c);
    const w = await world({
      telemetry,
      limits: {
        afterAuth: (_a, mcp) =>
          mcp.method === 'completion/complete' ? { ok: false, retryAfterSeconds: 3 } : { ok: true },
      },
    });
    const t = w.tokens.alice;
    const sent: Array<[string, unknown, number]> = [
      [
        'initialize',
        rpc(1, 'initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'x', version: '1' },
        }),
        200,
      ],
      ['notifications/initialized', { jsonrpc: '2.0', method: 'notifications/initialized' }, 202],
      ['ping', rpc(3, 'ping'), 200],
      ['tools/list', rpc(4, 'tools/list'), 200],
      ['tools/call', rpc(5, 'tools/call', { name: 'whoami', arguments: {} }), 200],
      ['prompts/list', rpc(6, 'prompts/list'), 200],
      ['resources/list', rpc(7, 'resources/list'), 200],
      ['completion/complete', rpc(8, 'completion/complete', { ref: {}, argument: {} }), 429],
      ['other', rpc(9, 'made/up'), 200],
      ['tools/call unknown', rpc(12, 'tools/call', { name: 'steal_everything', arguments: {} }), 200],
    ];
    for (const [, body, status] of sent) expect((await call(w, 'team-a', t, body)).res.status).toBe(status);
    // Refused before any method ran.
    expect((await call(w, 'team-a', null, rpc(10, 'tools/list'))).res.status).toBe(401);
    expect(
      (await call(w, 'team-a', 'ab_live_not-a-token', rpc(11, 'tools/call', { name: 'whoami' }))).res.status,
    ).toBe(401);
    expect((await call(w, 'team-a', t, 'not json')).res.status).toBe(400);
    expect((await call(w, 'team-a', t, [rpc(1, 'ping')])).res.status).toBe(400);
    const get = await w.app.fetch(
      new Request(`${ORIGIN}/w/team-a/mcp`, {
        headers: { host: '127.0.0.1:8787', authorization: `Bearer ${t}` },
      }),
    );
    await get.text();
    expect(get.status).toBe(405);
    await telemetry.flush();

    const spans = c.spans();
    expect(spans).toHaveLength(sent.length + 5);
    const byName = (n: string) => spans.filter((s) => s.name === n);
    expect(spans.map((s) => s.name).sort()).toEqual(
      [
        'initialize',
        'notifications/initialized',
        'ping',
        'tools/list',
        'tools/call whoami',
        'prompts/list',
        'resources/list',
        'completion/complete',
        'other',
        'tools/call unknown',
        'other',
        'other',
        'other',
        'other',
        'other',
      ].sort(),
    );
    expect(byName('tools/call whoami')[0]?.attrs).toMatchObject({
      'agility_bridge.method_class': 'tool_call',
      'agility_bridge.outcome': 'ok',
      'agility_bridge.fault': 'none',
      'http.response.status_code': 200,
    });
    expect(byName('completion/complete')[0]?.attrs).toMatchObject({
      'agility_bridge.outcome': 'rate_limited',
      'agility_bridge.fault': 'caller',
      'error.type': 'AB_LIMIT_RATE',
      'http.response.status_code': 429,
    });
    // Refused at the door: the body is not read before authentication, so the method is not known and is `other`.
    const refused = spans.filter((s) => s.attrs['agility_bridge.outcome'] === 'refused');
    expect(refused.length).toBeGreaterThanOrEqual(4);
    expect(refused.map((s) => s.attrs['agility_bridge.refusal'])).toEqual(
      expect.arrayContaining(['no_token', 'token_malformed', 'body', 'method']),
    );
    expect(refused.every((s) => s.statusCode === 0 && s.attrs['agility_bridge.fault'] === 'caller')).toBe(
      true,
    );
    // A tool name the caller made up is not exported.
    expect(spans.find((s) => s.name === 'tools/call unknown')?.attrs['gen_ai.tool.name']).toBe('unknown');
    expect(JSON.stringify(c.received.map((r) => r.body))).not.toContain('steal_everything');
  });
});

describe('error-rate semantics, end to end against a collector (L-118)', () => {
  const boom = defineTool({
    name: 'boom_test',
    title: 'Boom',
    description: 'Fails with an internal error, to test the server-fault classification (test tool).',
    kind: 'read',
    group: 'core',
    cost: 0,
    inputSchema: z.object({}),
    handler: async () => {
      throw new Error('kaboom with Salary review in it');
    },
  });

  it('counts server and upstream faults and never caller faults', async () => {
    const c = collector();
    const telemetry = telemetryFor(c);
    let upstreamDown = false;
    const w = await world(
      { telemetry, tools: [...CORE_TOOLS, boom] },
      {
        tools: new Map([...TOOL_INFO, ['boom_test', { kind: 'read' as const, group: 'core' }]]),
        agility: (req) =>
          upstreamDown && req.url.includes('query.v1') ? new Response('{}', { status: 500 }) : undefined,
      },
    );
    const t = w.tokens.alice;
    const tool = (name: string, args: unknown, id = 1) =>
      call(w, 'team-a', t, rpc(id, 'tools/call', { name, arguments: args }));
    // Successes.
    await tool('whoami', {});
    await tool('whoami', {});
    await tool('get_assets', { assets: ['B-00001'] });
    // Caller faults: bad input, a made-up asset, a refusal at the door.
    await tool('get_assets', { assets: 'not-a-list' });
    await tool('get_assets', { assets: ['B-99999'] });
    await call(w, 'team-a', null, rpc(9, 'tools/list'));
    // A server fault: an unexpected exception inside a tool.
    await tool('boom_test', {});
    // An upstream fault: Agility answering 500.
    upstreamDown = true;
    await tool('get_assets', { assets: ['B-00001'] });
    await telemetry.flush();

    const spans = c.spans();
    const calls = spans.filter(
      (s) =>
        s.attrs['agility_bridge.method_class'] === 'tool_call' ||
        s.attrs['agility_bridge.refusal'] !== undefined,
    );
    expect(calls).toHaveLength(8);
    const fault = (f: string) => calls.filter((s) => s.attrs['agility_bridge.fault'] === f);
    // Three successes and a lookup of an asset that does not exist (an empty, successful answer).
    expect(fault('none')).toHaveLength(4);
    expect(fault('caller')).toHaveLength(2);
    expect(fault('server')).toHaveLength(1);
    expect(fault('server')[0]?.attrs['error.type']).toBe('AB_INTERNAL');
    expect(fault('upstream')).toHaveLength(1);
    expect(String(fault('upstream')[0]?.attrs['error.type'])).toMatch(/^AB_AGILITY_/);
    // The span status carries it: ERROR (2) for server and upstream only.
    expect(
      calls
        .filter((s) => s.statusCode === 2)
        .map((s) => s.attrs['agility_bridge.fault'])
        .sort(),
    ).toEqual(['server', 'upstream']);
    expect(
      calls.filter((s) => s.attrs['agility_bridge.fault'] === 'caller').every((s) => s.statusCode === 0),
    ).toBe(true);
    // The error rate an operator would compute from the spans: 2 service errors of 8 requests, not 4 of 8.
    const rate = calls.filter((s) => s.statusCode === 2).length / calls.length;
    expect(rate).toBe(2 / 8);
    // Agility requests used by a call are reported as a count.
    expect(
      calls.find((s) => s.attrs['gen_ai.tool.name'] === 'get_assets')?.attrs['agility_bridge.requests'],
    ).toEqual(expect.any(Number));
    // The exception text and the tool input never left.
    expect(c.received.map((r) => r.body).join('')).not.toMatch(/kaboom|Salary review|not-a-list|B-99999/);
  });
});

describe('what leaves the process (L-119)', () => {
  it('contains nothing but allowlisted attributes on a full run, and none of the secrets or content used', async () => {
    const c = collector();
    const telemetry = telemetryFor(c);
    const w = await world({ telemetry });
    const t = w.tokens.alice;
    const marker = 'PRIVATE-MARKER-VALUE';
    await call(
      w,
      'team-a',
      t,
      rpc(1, 'tools/call', { name: 'get_assets', arguments: { assets: ['B-00001'], fields: [marker] } }),
      {
        'x-forwarded-for': '203.0.113.77',
        'x-secret-header': marker,
      },
    );
    await call(
      w,
      'team-a',
      t,
      rpc(2, 'tools/call', {
        name: 'query_assets',
        arguments: { asset_type: 'Story', filters: [{ field: 'Name', op: 'contains', value: marker }] },
      }),
    );
    await call(w, 'team-a', t, rpc(3, 'resources/read', { uri: `agility://stories/${marker}` }));
    await call(w, 'team-a', t, rpc(4, 'prompts/get', { name: `prompt-${marker}`, arguments: { x: marker } }));
    await call(w, 'team-a', 'ab_live_notatoken', rpc(5, 'tools/list'));
    await call(w, 'team-b', w.tokens.bob, rpc(6, 'tools/call', { name: 'whoami', arguments: {} }));
    await telemetry.flush();

    const allowed = new Set([
      'mcp.method.name',
      'agility_bridge.method_class',
      'gen_ai.tool.name',
      'http.response.status_code',
      'agility_bridge.outcome',
      'agility_bridge.fault',
      'error.type',
      'agility_bridge.refusal',
      'agility_bridge.requests',
      'agility_bridge.request_id',
    ]);
    const spans = c.spans();
    expect(spans.length).toBe(6);
    for (const s of spans) for (const k of Object.keys(s.attrs)) expect(allowed.has(k), k).toBe(true);
    const everything = c.received.map((r) => r.body).join('\n');
    for (const forbidden of [
      marker,
      w.tokens.alice,
      w.tokens.bob,
      ALICE_AGILITY,
      'team-a',
      'team-b',
      'Team A',
      'alice@example.test',
      'In A',
      'B-00001',
      '203.0.113.77',
      'ab_live_notatoken',
      'COLLECTOR-KEY',
      'x-secret-header',
      'Bearer',
      'agility://',
    ]) {
      expect(everything, forbidden).not.toContain(forbidden);
    }
    // The collector's own key went in a header, once per request, and not in the body.
    expect(c.received.every((r) => r.headers.get('authorization') === 'Bearer COLLECTOR-KEY')).toBe(true);
    expect(c.received.every((r) => r.path === '/v1/traces')).toBe(true);
    // The resource says who sends, nothing else.
    const resource = JSON.parse(c.received[0]?.body ?? '{}').resourceSpans[0].resource.attributes as Array<{
      key: string;
    }>;
    expect(resource.map((a) => a.key).sort()).toEqual([
      'deployment.environment.name',
      'service.name',
      'service.version',
    ]);
  });
});

describe('traceparent (strict, never forwarded)', () => {
  const GOOD = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const TRACESTATE = 'vendor=SECRET-TRACESTATE';

  it('joins the caller trace only when authenticated and valid, and ignores tracestate', async () => {
    const c = collector();
    const telemetry = telemetryFor(c);
    const w = await world({ telemetry });
    const t = w.tokens.alice;
    const list = rpc(1, 'tools/list');
    const authed = await call(w, 'team-a', t, list, {
      traceparent: GOOD,
      tracestate: TRACESTATE,
      baggage: 'k=SECRET-BAGGAGE',
    });
    await call(w, 'team-a', null, list, { traceparent: GOOD });
    await call(w, 'team-a', t, list, { traceparent: GOOD.toUpperCase() });
    await call(w, 'team-a', t, list, { traceparent: `${GOOD}-extra` });
    await call(w, 'team-a', t, list);
    await telemetry.flush();
    const spans = c.spans();
    expect(spans).toHaveLength(5);
    expect(spans[0]).toMatchObject({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentSpanId: '00f067aa0ba902b7',
    });
    for (const s of spans.slice(1)) {
      expect(s.traceId).not.toBe('4bf92f3577b34da6a3ce929d0e0e4736');
      expect(s.parentSpanId).toBeUndefined();
    }
    expect(new Set(spans.map((s) => s.spanId)).size).toBe(5);
    // Nothing is returned to the caller, and the other trace headers are never read.
    expect(authed.res.headers.get('traceparent')).toBeNull();
    expect(authed.res.headers.get('tracestate')).toBeNull();
    expect(c.received.map((r) => r.body).join('')).not.toMatch(/SECRET-TRACESTATE|SECRET-BAGGAGE/);
  });

  it('never sends a trace header to Agility, with or without telemetry', async () => {
    for (const on of [true, false]) {
      const c = collector();
      const seen: string[] = [];
      const w = await world(on ? { telemetry: telemetryFor(c) } : {}, {
        agility: (req) => {
          for (const name of req.headers.keys()) seen.push(name);
          return undefined;
        },
      });
      await call(
        w,
        'team-a',
        w.tokens.alice,
        rpc(1, 'tools/call', { name: 'get_assets', arguments: { assets: ['B-00001'] } }),
        {
          traceparent: GOOD,
          tracestate: TRACESTATE,
          baggage: 'k=v',
          'x-request-id': 'forged',
        },
      );
      expect(seen.length).toBeGreaterThan(0);
      for (const forbidden of ['traceparent', 'tracestate', 'baggage', 'x-request-id'])
        expect(seen).not.toContain(forbidden);
    }
  });
});

describe('a collector that is off, down, slow or failing never reaches a caller', () => {
  it('is off by default: nothing is sent anywhere', async () => {
    const c = collector();
    const w = await world();
    expect((await call(w, 'team-a', w.tokens.alice, rpc(1, 'tools/list'))).res.status).toBe(200);
    expect(c.received).toHaveLength(0);
  });

  it('answers the caller normally when the collector refuses, errors or is gone', async () => {
    const failing = collector(() => ({ status: 500 }));
    const gone = collector(() => 'gone');
    for (const c of [failing, gone]) {
      const w = await world({ telemetry: telemetryFor(c, { flushEach: true, timeoutMs: 500 }) });
      for (let i = 0; i < 3; i++) {
        const r = await call(
          w,
          'team-a',
          w.tokens.alice,
          rpc(i, 'tools/call', { name: 'whoami', arguments: {} }),
        );
        expect(r.res.status).toBe(200);
        expect(r.text).toContain('Team A');
      }
    }
    expect(failing.received.length).toBeGreaterThan(0);
    expect(gone.received.length).toBeGreaterThan(0);
  });

  it('does not wait for a slow collector', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const slow = collector(() => ({ status: 200, hold }));
    const w = await world({ telemetry: telemetryFor(slow, { flushEach: true, timeoutMs: 5_000 }) });
    const r = await call(
      w,
      'team-a',
      w.tokens.alice,
      rpc(1, 'tools/call', { name: 'whoami', arguments: {} }),
    );
    expect(r.res.status).toBe(200);
    // The span is on its way, the collector has not answered, and the caller already has its answer.
    await new Promise((res) => setTimeout(res, 50));
    expect(slow.received.length).toBe(1);
    release();
  });
});

describe('the settings', () => {
  const defaults = { callBudget: 1000, maxResponseBytes: 8_388_608 };
  it('are off by default and accept an https or loopback endpoint with headers', () => {
    expect(parseServerSettings({}, defaults).otel).toBeUndefined();
    const s = parseServerSettings(
      { AB_OTEL_ENDPOINT: 'https://otel.example.com/', AB_OTEL_HEADERS: 'authorization=Bearer abc' },
      defaults,
    );
    expect(s.otel).toEqual({
      endpoint: 'https://otel.example.com',
      headers: { authorization: 'Bearer abc' },
    });
    expect(parseServerSettings({ AB_OTEL_ENDPOINT: 'http://127.0.0.1:4318' }, defaults).otel?.endpoint).toBe(
      'http://127.0.0.1:4318',
    );
    for (const n of ['AB_OTEL_ENDPOINT', 'AB_OTEL_HEADERS']) expect(SERVER_SETTING_NAMES).toContain(n);
  });

  it.each([
    [{ AB_OTEL_ENDPOINT: 'http://otel.example.com' }, 'AB_OTEL_ENDPOINT'],
    [{ AB_OTEL_ENDPOINT: 'https://u:p@otel.example.com' }, 'AB_OTEL_ENDPOINT'],
    [{ AB_OTEL_ENDPOINT: 'https://otel.example.com', AB_OTEL_HEADERS: 'nonsense-SECRET' }, 'AB_OTEL_HEADERS'],
    [{ AB_OTEL_HEADERS: 'authorization=Bearer SECRET-VALUE' }, 'AB_OTEL_HEADERS'],
  ])('refuses %j naming the variable and never the secret', (env, name) => {
    try {
      parseServerSettings(env, defaults);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SettingsError);
      expect((e as Error).message).toContain(name);
      expect((e as Error).message).not.toMatch(/SECRET/);
    }
  });

  it('warns at start with the collector host only', () => {
    const s = parseServerSettings(
      {
        AB_OTEL_ENDPOINT: 'https://otel.example.com/path/KEY',
        AB_OTEL_HEADERS: 'authorization=Bearer SECRET-VALUE',
      },
      defaults,
    );
    const warning = settingWarnings({}, s).find((w) => w.includes('AB_OTEL_ENDPOINT'));
    expect(warning).toContain('otel.example.com');
    expect(warning).not.toMatch(/KEY|SECRET/);
    expect(settingWarnings({}, parseServerSettings({}, defaults)).join('')).not.toContain('AB_OTEL');
  });
});
