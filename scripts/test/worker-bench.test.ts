// SPDX-License-Identifier: Apache-2.0
// The CPU regression check of scripts/worker-bench.ts (P3-10).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type BenchResult, median, regressions } from '../worker-bench.ts';

const baseline = JSON.parse(
  readFileSync(new URL('../bench/worker-baseline.json', import.meta.url), 'utf8'),
) as BenchResult;

describe('worker-bench regressions', () => {
  it('passes the baseline against itself and flags an injected 3× slowdown of one path only', () => {
    expect(regressions(baseline, baseline)).toEqual([]);
    const slowed: BenchResult = {
      ...baseline,
      relative: {
        ...baseline.relative,
        'warm: tools/list': (baseline.relative['warm: tools/list'] ?? 1) * 3,
      },
    };
    const flagged = regressions(slowed, baseline);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatch(/^warm: tools\/list/);
  });

  it('tolerates noise under 2× and ignores paths that are new', () => {
    const noisy: BenchResult = {
      ...baseline,
      relative: Object.fromEntries(Object.entries(baseline.relative).map(([k, v]) => [k, v * 1.9])),
    };
    expect(regressions(noisy, baseline)).toEqual([]);
    expect(
      regressions({ ...baseline, relative: { ...baseline.relative, 'warm: new_tool': 99 } }, baseline),
    ).toEqual([]);
  });

  it('the baseline covers the cold boot and the warm calls, with their Agility requests', () => {
    expect(Object.keys(baseline.relative)).toEqual(
      expect.arrayContaining(['cold: boot', 'warm: tools/list', 'warm: search_work_items']),
    );
    expect(baseline.requests['search_work_items']).toBeGreaterThan(0);
    expect(median([3, 1, 2])).toBe(2);
  });

  it('the baseline covers the panel: first and warm requests, none of them reaching Agility', () => {
    expect(Object.keys(baseline.relative)).toEqual(
      expect.arrayContaining([
        'cold: first /admin',
        'warm: admin: overview',
        'warm: admin: users list',
        'warm: admin: audit',
        'warm: admin: asset',
        'warm: admin: form POST',
      ]),
    );
    for (const k of ['overview', 'users list', 'audit', 'asset', 'form POST'])
      expect(baseline.requests[`admin: ${k}`], k).toBe(0);
    const slowed: BenchResult = {
      ...baseline,
      relative: {
        ...baseline.relative,
        'cold: first /admin': (baseline.relative['cold: first /admin'] ?? 1) * 3,
      },
    };
    expect(regressions(slowed, baseline)).toHaveLength(1);
  });
});
