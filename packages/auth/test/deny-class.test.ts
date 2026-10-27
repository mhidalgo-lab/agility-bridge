// SPDX-License-Identifier: Apache-2.0
// Every access refusal is final or recoverable, never both and never neither (P5-21, D-77, ADR-0018).
import { describe, expect, it } from 'vitest';
import { DENY_CLASS, DENY_REASONS, type DenyReason, isRecoverableDeny } from '../src/index.ts';

describe('DenyReason classes', () => {
  it('classifies every DenyReason, and nothing else', () => {
    // `DenyReason` is `DENY_REASONS[number]` and `DENY_CLASS` is a `Record<DenyReason, ...>`: a new reason does not
    // compile until it is classified; this fails at run time too when the two lists drift apart.
    expect(DENY_REASONS.length).toBeGreaterThan(15);
    expect(new Set(DENY_REASONS).size).toBe(DENY_REASONS.length);
    expect(Object.keys(DENY_CLASS).sort()).toEqual([...DENY_REASONS].sort());
    for (const reason of DENY_REASONS) {
      expect(['final', 'recoverable'], reason).toContain(DENY_CLASS[reason as DenyReason]);
    }
  });

  it('puts the recoverable reasons D-77 named in the recoverable class and keeps the rest final', () => {
    const recoverable = Object.entries(DENY_CLASS)
      .filter(([, c]) => c === 'recoverable')
      .map(([r]) => r)
      .sort();
    expect(recoverable).toEqual(
      [
        'credential_revoked',
        'credential_unvalidated',
        'instance_disabled',
        'no_projects',
        'no_tools',
        'user_disabled',
        'workspace_disabled',
      ].sort(),
    );
    for (const reason of [
      'grant_revoked',
      'grant_expired',
      'user_missing',
      'grant_missing',
      'wrong_workspace',
      'workspace_missing',
      'token_revoked',
      'token_expired',
      'instance_missing',
      'credential_missing',
      'credential_mismatch',
      'malformed_policy',
      'not_passthrough',
    ] as const) {
      expect(isRecoverableDeny(reason), reason).toBe(false);
    }
  });
});
