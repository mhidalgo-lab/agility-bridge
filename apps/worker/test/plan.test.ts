// SPDX-License-Identifier: Apache-2.0
// Workers plan presets (P3-03, ADR-0010).
import { describe, expect, it } from 'vitest';
import { BootError, PLAN_PRESETS, workerSettings, workersPlan } from '../src/boot.ts';

describe('workersPlan', () => {
  it('defaults to free, accepts paid and refuses anything else', () => {
    expect(workersPlan({})).toBe('free');
    expect(workersPlan({ AB_PLAN: 'paid' })).toBe('paid');
    expect(() => workersPlan({ AB_PLAN: 'enterprise' })).toThrow(BootError);
  });

  it('presets: Free 45 requests and 512 KiB as ceilings (under 50 subrequests), Paid 1,000 and 8 MiB', () => {
    expect(PLAN_PRESETS.free).toEqual({ callBudget: 45, maxResponseBytes: 524_288, ceiling: true });
    expect(PLAN_PRESETS.paid).toEqual({ callBudget: 1_000, maxResponseBytes: 8_388_608, ceiling: false });
  });

  it('AB_PLAN is a Worker setting; Node-only settings are refused', () => {
    expect(workerSettings({ AB_PLAN: 'paid', DB: {} as never })).toEqual({ AB_PLAN: 'paid' });
    expect(() => workerSettings({ AB_DATA_DIR: '/data' })).toThrow(/AB_DATA_DIR/);
  });
});
