// SPDX-License-Identifier: Apache-2.0
// Batching on a host with no timer of its own (P8-43, D-324, T30): many requests, few exports, every span whole, a queue
// bounded in count and bytes, an age flush handed to the request that armed it, and a collector that is down or silent.
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger.ts';
import {
  createTelemetry,
  type FinishedSpan,
  type SpanExporter,
  type SpanInput,
} from '../../src/telemetry/index.ts';

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

/** A sleep the test releases by hand: the wait that one request's `waitUntil` holds. */
function sleeps() {
  const pending: Array<() => void> = [];
  return { sleep: () => new Promise<void>((r) => pending.push(r)), pending };
}

function setup(over: Partial<Parameters<typeof createTelemetry>[0]> = {}) {
  const exported: FinishedSpan[][] = [];
  const logs: string[] = [];
  const exporter: SpanExporter = {
    export: async (spans) => {
      exported.push([...spans]);
    },
  };
  const now = { t: 1_000 };
  const s = sleeps();
  const telemetry = createTelemetry({
    exporter,
    clock: { now: () => now.t },
    random: {
      uuid: () => '00000000-0000-4000-8000-000000000000',
      bytes: (n) => new Uint8Array(n).fill(0xab),
    },
    logger: createLogger({ level: 'debug', sink: (l) => logs.push(l) }),
    knownTools: new Set(['whoami']),
    service: { version: '0.8.0', environment: 'production' },
    sleep: s.sleep,
    ...over,
  });
  return { telemetry, exported, logs, now, s };
}

describe('batching without a timer (P8-43)', () => {
  it('turns many requests into few exports, each span whole', async () => {
    const { telemetry, exported, s } = setup({ batchSize: 10 });
    const work: Promise<void>[] = [];
    for (let i = 0; i < 25; i++) {
      const w = telemetry.record(
        input({ requestId: `3f2b8a6e-1c1d-4f2a-9d3e-0a1b2c3d${String(i).padStart(4, '0')}` }),
      );
      if (w !== undefined) work.push(w);
    }
    // Two size flushes are out; the age wait armed by the first span holds the last five.
    expect(exported.map((b) => b.length)).toEqual([10, 10]);
    expect(s.pending).toHaveLength(1);
    s.pending[0]?.();
    await Promise.all(work);
    expect(exported.map((b) => b.length)).toEqual([10, 10, 5]);
    const all = exported.flat();
    expect(new Set(all.map((x) => x.attributes['agility_bridge.request_id'])).size).toBe(25);
    for (const span of all) {
      expect(span.attributes['gen_ai.tool.name']).toBe('whoami');
      expect(span.attributes['mcp.method.name']).toBe('tools/call');
      expect(span.attributes['http.response.status_code']).toBe(200);
    }
  });

  it('arms one age wait at a time, and another when the request that held it was cut short', async () => {
    const { telemetry, exported, now, s } = setup({ batchSize: 100, maxAgeMs: 1_000 });
    expect(telemetry.record(input())).toBeInstanceOf(Promise);
    expect(telemetry.record(input())).toBeUndefined();
    expect(s.pending).toHaveLength(1);
    now.t += 2_500;
    const second = telemetry.record(input());
    expect(second).toBeInstanceOf(Promise);
    expect(s.pending).toHaveLength(2);
    s.pending[1]?.();
    await second;
    expect(exported.flat()).toHaveLength(3);
  });

  it('is bounded in count and in bytes, drops the oldest first and counts them', async () => {
    const counted = setup({ batchSize: 1_000, maxQueue: 5 });
    for (let i = 0; i < 9; i++) counted.telemetry.record(input());
    expect(counted.telemetry.stats().dropped).toBe(4);
    await counted.telemetry.flush();
    expect(counted.exported.flat()).toHaveLength(5);

    // Bytes: with the collector silent, the queue stops at its byte limit, however many spans arrive.
    let sizes: number[] = [];
    const sized = setup({
      batchSize: 1_000,
      maxQueueBytes: 2_000,
      maxInFlight: 1,
      exporter: {
        export: async (spans) => {
          sizes.push(spans.length);
          await new Promise<void>(() => {});
        },
      },
    });
    for (let i = 0; i < 200; i++) sized.telemetry.record(input());
    expect(sizes).toHaveLength(1);
    expect(sized.telemetry.stats().dropped).toBeGreaterThan(150);
    sizes = [];
  });

  it('a collector that never answers neither delays record nor lets the queue grow past its bounds', async () => {
    let calls = 0;
    const { telemetry } = setup({
      batchSize: 2,
      maxQueue: 6,
      maxInFlight: 2,
      exporter: {
        export: async () => {
          calls += 1;
          await new Promise<void>(() => {});
        },
      },
    });
    const started = Date.now();
    for (let i = 0; i < 50; i++) telemetry.record(input());
    expect(Date.now() - started).toBeLessThan(500);
    // Two exports hang with two spans each; the rest wait in a queue that keeps six at most.
    expect(calls).toBe(2);
    expect(telemetry.stats().dropped).toBeGreaterThanOrEqual(50 - 4 - 6);
  });

  it('a failing export is counted once, its spans are not queued again and nothing of the endpoint is logged', async () => {
    const { telemetry, logs } = setup({
      batchSize: 2,
      exporter: {
        export: async () => {
          throw new Error('https://collector.example.com/secret-path');
        },
      },
    });
    telemetry.record(input());
    await telemetry.record(input());
    expect(telemetry.stats().failedBatches).toBe(1);
    await telemetry.flush();
    expect(telemetry.stats().failedBatches).toBe(1);
    expect(logs.join('\n')).not.toContain('secret-path');
  });

  it('without `sleep` (Node) nothing is armed: the host flushes on its own timer', () => {
    const { telemetry } = setup({ batchSize: 100, sleep: undefined as never });
    expect(telemetry.record(input())).toBeUndefined();
  });
});
