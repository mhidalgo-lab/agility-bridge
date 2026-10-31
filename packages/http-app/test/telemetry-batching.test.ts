// SPDX-License-Identifier: Apache-2.0
// Span batching on the Workers shape and the Node shape (P8-43, D-324, T30): the HTTP app with per-request isolation and a
// `background` that records what each request handed to `waitUntil`, against a fake collector.
import {
  CORE_TOOLS,
  createOtlpExporter,
  createTelemetry,
  type Telemetry,
  telemetryResource,
} from '@agility-bridge/core';
import { describe, expect, it } from 'vitest';
import { post, world } from './helpers/world.ts';

const rpc = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id, method, params });
const quiet = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => quiet,
};

function collector(hold?: Promise<void>) {
  const bodies: string[] = [];
  return {
    bodies,
    fetch: async (request: Request) => {
      bodies.push(await request.text());
      if (hold !== undefined) await hold;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
    spans: () =>
      bodies.flatMap((b) =>
        (
          JSON.parse(b) as {
            resourceSpans: { scopeSpans: { spans: { name: string; attributes: { key: string }[] }[] }[] }[];
          }
        ).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)),
      ),
  };
}

function telemetryFor(
  fetch: (r: Request) => Promise<Response>,
  over: Partial<Parameters<typeof createTelemetry>[0]> = {},
): Telemetry {
  return createTelemetry({
    exporter: createOtlpExporter({
      endpoint: 'https://collector.example.com',
      fetch,
      resource: { attributes: telemetryResource({ version: '0.0.0-test', environment: 'test' }) },
    }),
    clock: { now: () => Date.now() },
    random: { uuid: () => crypto.randomUUID(), bytes: (n) => crypto.getRandomValues(new Uint8Array(n)) },
    logger: quiet,
    knownTools: new Set(CORE_TOOLS.map((t) => t.name)),
    service: { version: '0.0.0-test', environment: 'test' },
    ...over,
  });
}

/** The Workers shape: per-request isolation, a detached audit writer and a `waitUntil` that keeps what it is given. */
async function workersWorld(telemetry: Telemetry) {
  const waited: Promise<unknown>[] = [];
  const w = await world(
    { telemetry, isolation: 'request', background: (_c, work) => void waited.push(work) },
    { detachedAudit: true },
  );
  return { w, waited };
}

describe('Workers: spans are batched per isolate and flushed through waitUntil', () => {
  it('sends fewer collector requests than requests, with every span and its attributes', async () => {
    const c = collector();
    const release: Array<() => void> = [];
    const telemetry = telemetryFor(c.fetch, {
      batchSize: 5,
      sleep: () => new Promise<void>((r) => release.push(r)),
    });
    const { w, waited } = await workersWorld(telemetry);
    for (let i = 0; i < 12; i++) {
      const res = await post(
        w,
        'team-a',
        w.tokens.alice,
        rpc(i, 'tools/call', { name: 'whoami', arguments: {} }),
      );
      expect(res.status).toBe(200);
      await res.text();
    }
    for (const r of release) r();
    await Promise.all(waited);
    const spans = c.spans();
    expect(spans).toHaveLength(12);
    expect(c.bodies.length).toBeLessThanOrEqual(3);
    for (const s of spans) {
      expect(s.name).toBe('tools/call whoami');
      expect(s.attributes.map((a) => a.key).sort()).toEqual([
        'agility_bridge.fault',
        'agility_bridge.method_class',
        'agility_bridge.outcome',
        'agility_bridge.request_id',
        'agility_bridge.requests',
        'gen_ai.tool.name',
        'http.response.status_code',
        'mcp.method.name',
      ]);
    }
    // Nothing from the requests (workspace, token, address) is in what was sent.
    expect(c.bodies.join('\n')).not.toMatch(/team-a|alice|Bearer|ab_/i);
  });

  it('a collector that never answers does not delay a response and the queue stays bounded', async () => {
    const hold = new Promise<void>(() => {});
    const c = collector(hold);
    const telemetry = telemetryFor(c.fetch, { batchSize: 2, maxQueue: 8, maxInFlight: 1, sleep: () => hold });
    const { w } = await workersWorld(telemetry);
    const started = Date.now();
    for (let i = 0; i < 40; i++) {
      const res = await post(w, 'team-a', w.tokens.alice, rpc(i, 'ping'));
      expect(res.status).toBe(200);
      await res.text();
    }
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(c.bodies).toHaveLength(1);
    expect(telemetry.stats().dropped).toBeGreaterThanOrEqual(40 - 2 - 8);
  });

  it('still samples unauthenticated spans before they reach the queue (D-304)', async () => {
    const c = collector();
    const telemetry = telemetryFor(c.fetch, {
      batchSize: 100,
      unauthenticatedPerMinute: 2,
      sleep: () => Promise.resolve(),
    });
    const { w, waited } = await workersWorld(telemetry);
    for (let i = 0; i < 8; i++) expect((await post(w, 'team-a', null, rpc(i, 'ping'))).status).toBe(401);
    await Promise.all(waited);
    await telemetry.flush();
    expect(c.spans()).toHaveLength(2);
    expect(telemetry.stats().sampledOut).toBe(6);
  });
});

describe('Node: the timer flush is unchanged', () => {
  it('queues until the host flushes, hands nothing to a background and exports the same spans', async () => {
    const c = collector();
    const telemetry = telemetryFor(c.fetch, { batchSize: 100 });
    const w = await world({ telemetry });
    for (let i = 0; i < 4; i++) {
      const res = await post(
        w,
        'team-a',
        w.tokens.alice,
        rpc(i, 'tools/call', { name: 'whoami', arguments: {} }),
      );
      await res.text();
    }
    expect(c.bodies).toHaveLength(0);
    await telemetry.flush();
    expect(c.bodies).toHaveLength(1);
    expect(c.spans()).toHaveLength(4);
    expect(c.spans()[0]?.name).toBe('tools/call whoami');
  });
});
