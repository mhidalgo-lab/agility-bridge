// SPDX-License-Identifier: Apache-2.0
// P9-03: the helpers of the measurement scripts (percentiles, the `wrangler tail` parser) and the mock upstream.
import { describe, expect, it } from 'vitest';
import { percentile, summarize } from '../perf/latency.ts';
import { startMock } from '../perf/mock-agility.ts';
import { splitJson, tailCpu } from '../perf/tail-cpu.ts';

describe('latency summary', () => {
  it('takes nearest-rank percentiles and the mean of the request counts', () => {
    const ms = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    expect(percentile(ms, 50)).toBe(100);
    expect(percentile(ms, 95)).toBe(190);
    expect(summarize(ms, [2, 4], 1)).toMatchObject({
      p50: 100,
      p95: 190,
      min: 10,
      max: 200,
      requests: 3,
      errors: 1,
    });
    expect(summarize([], [], 0).requests).toBeNull();
  });
});

describe('tail capture', () => {
  const event = (tag: string, cpu: number, outcome = 'ok') =>
    JSON.stringify(
      {
        cpuTime: cpu,
        wallTime: cpu * 10,
        outcome,
        event: { request: { url: `https://x.example/w/a/mcp?perf=${tag}` } },
      },
      null,
      2,
    );

  it('splits pretty-printed objects, braces inside strings included', () => {
    expect(splitJson(`${event('a:0', 1)}\n${JSON.stringify({ s: '}{ "' })}`)).toHaveLength(2);
  });

  it('groups by tool, keeps the warm-up apart and counts samples over 10 ms and failures', () => {
    const text = [
      event('t:warmup', 40),
      event('t:0', 5),
      event('t:1', 12),
      event('t:2', 0, 'exceededCpu'),
    ].join('\n');
    expect(tailCpu(text)['t']).toMatchObject({ samples: 3, over10: 1, notOk: 1, warmupCpu: 40, cpuMax: 12 });
  });
});

describe('mock upstream', () => {
  it('answers Agility-shaped rows after the modelled delay and counts requests', async () => {
    const running = await startMock(0, { query: 1, sortedByChangeDate: 1, meta: 1, history: 1, other: 1 });
    try {
      const res = await fetch(`${running.url}/query.v1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'Story', select: ['Name'], page: { size: 3 } }),
      });
      expect(((await res.json()) as unknown[][])[0]).toHaveLength(3);
      expect(running.mock.count()).toBe(1);
    } finally {
      await running.close();
    }
  });
});
