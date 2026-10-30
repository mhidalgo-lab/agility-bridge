// SPDX-License-Identifier: Apache-2.0
// Workers plan presets (P3-03, ADR-0010).

import { parseServerSettings } from '@agility-bridge/http-app';
import { describe, expect, it } from 'vitest';
import { BootError, PLAN_PRESETS, workerSettings, workersPlan } from '../src/boot.ts';

describe('workersPlan', () => {
  it('defaults to free, accepts paid and refuses anything else', () => {
    expect(workersPlan({})).toBe('free');
    expect(workersPlan({ AB_PLAN: 'paid' })).toBe('paid');
    expect(() => workersPlan({ AB_PLAN: 'enterprise' })).toThrow(BootError);
  });

  it('presets: Free 45 requests and 512 KiB as ceilings (under 50 subrequests), Paid 1,000 and 8 MiB', () => {
    expect(PLAN_PRESETS.free).toEqual({
      callBudget: 45,
      maxResponseBytes: 524_288,
      writeDeploymentRate: 60,
      ceiling: true,
    });
    expect(PLAN_PRESETS.paid).toEqual({ callBudget: 1_000, maxResponseBytes: 8_388_608, ceiling: false });
  });

  it('the deployment write cap defaults to 60 an hour on Free (under half of 100,000 D1 rows a day) and 200 on Paid (P7-30)', () => {
    const free = parseServerSettings({}, PLAN_PRESETS.free);
    const paid = parseServerSettings({}, PLAN_PRESETS.paid);
    expect(free.writeRates.deployment).toBe(60);
    expect(paid.writeRates.deployment).toBe(200);
    // 60 an hour, every write by the approval page at 31 rows (docs/guide/cloudflare-limits.md): below half the daily budget.
    expect(60 * 24 * 31).toBeLessThan(100_000 / 2);
    expect(
      parseServerSettings({ AB_WRITE_RATE_DEPLOYMENT_HOURLY: '40' }, PLAN_PRESETS.free).writeRates.deployment,
    ).toBe(40);
  });

  it('the query cache is off by default; its TTL is 0-60 s and the shared tier is a separate switch (P8-01)', () => {
    expect(parseServerSettings({}, PLAN_PRESETS.free).queryCache).toEqual({ ttlSeconds: 0, edge: false });
    const on = parseServerSettings(
      { AB_QUERY_CACHE_TTL: '20', AB_QUERY_CACHE_EDGE: 'on' },
      PLAN_PRESETS.free,
    ).queryCache;
    expect(on).toEqual({ ttlSeconds: 20, edge: true });
    for (const bad of ['61', '-1', 'x', '1.5'])
      expect(() => parseServerSettings({ AB_QUERY_CACHE_TTL: bad }, PLAN_PRESETS.free)).toThrow(
        /AB_QUERY_CACHE_TTL/,
      );
    expect(() => parseServerSettings({ AB_QUERY_CACHE_EDGE: 'maybe' }, PLAN_PRESETS.free)).toThrow(
      /AB_QUERY_CACHE_EDGE/,
    );
    expect(workerSettings({ AB_QUERY_CACHE_TTL: '5', AB_QUERY_CACHE_EDGE: 'on' })).toEqual({
      AB_QUERY_CACHE_TTL: '5',
      AB_QUERY_CACHE_EDGE: 'on',
    });
  });

  it('per-grant quotas are off by default and take whole numbers from 1 (P8-09)', () => {
    expect(parseServerSettings({}, PLAN_PRESETS.free).quota).toEqual({ daily: null, monthly: null });
    expect(
      parseServerSettings({ AB_QUOTA_DAILY: '2000', AB_QUOTA_MONTHLY: '40000' }, PLAN_PRESETS.free).quota,
    ).toEqual({ daily: 2000, monthly: 40000 });
    expect(parseServerSettings({ AB_QUOTA_DAILY: '5' }, PLAN_PRESETS.free).quota).toEqual({
      daily: 5,
      monthly: null,
    });
    for (const bad of ['0', '-1', 'x', '1.5'])
      expect(() => parseServerSettings({ AB_QUOTA_MONTHLY: bad }, PLAN_PRESETS.free)).toThrow(
        /AB_QUOTA_MONTHLY/,
      );
    expect(workerSettings({ AB_QUOTA_DAILY: '10' })).toEqual({ AB_QUOTA_DAILY: '10' });
  });

  it('AB_PLAN is a Worker setting; Node-only settings are refused', () => {
    expect(workerSettings({ AB_PLAN: 'paid', DB: {} as never })).toEqual({ AB_PLAN: 'paid' });
    expect(() => workerSettings({ AB_DATA_DIR: '/data' })).toThrow(/AB_DATA_DIR/);
  });
});
