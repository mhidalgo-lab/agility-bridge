// SPDX-License-Identifier: Apache-2.0
// The effective request quota (P8-14, THREAT_MODEL T5): the lowest of the deployment's, workspace's and grant's value per
// period; a value never raises another; unlimited only when all three leave the period unset.
import { describe, expect, it } from 'vitest';
import { effectiveQuota, limitsPolicySchema } from '../src/access/index.ts';

describe('effectiveQuota', () => {
  it('takes the lowest value per period', () => {
    const q = effectiveQuota(
      { daily: 100, monthly: 1000 },
      { quota: { daily: 50 } },
      { quota: { daily: 70, monthly: 10 } },
    );
    expect(q).toEqual({ daily: 50, monthly: 10 });
  });
  it('is unlimited only where nobody sets the period', () => {
    expect(effectiveQuota(undefined, {}, {})).toEqual({ daily: null, monthly: null });
    expect(effectiveQuota({ daily: null, monthly: null }, {}, { quota: { monthly: 5 } })).toEqual({
      daily: null,
      monthly: 5,
    });
  });
  it('is validated like the other limits', () => {
    for (const quota of [
      { daily: 0 },
      { daily: 1.5 },
      { daily: '3' },
      { weekly: 3 },
      { monthly: 2_000_000_000 },
    ]) {
      expect(limitsPolicySchema.safeParse({ quota }).success, JSON.stringify(quota)).toBe(false);
    }
    expect(limitsPolicySchema.safeParse({ quota: { daily: 3, monthly: 30 } }).success).toBe(true);
  });
});
