// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { customRuleIds, missingRules, withoutFixtureAllowlist } from '../check-gitleaks-rules.ts';

const CONFIG = readFileSync(new URL('../../.gitleaks.toml', import.meta.url), 'utf8');

describe('gitleaks config', () => {
  it('defines the agility-bridge rules', () => {
    expect(customRuleIds(CONFIG)).toEqual([
      'agility-bridge-device-token',
      'agility-bridge-admin-token',
      'agility-bridge-master-key',
      'agility-bridge-master-key-assignment',
      'agility-access-token-assignment',
      'agility-access-token-bearer',
    ]);
  });

  it('allowlists the fixtures by path only, never by a word that also appears in real tokens', () => {
    const allowlist = CONFIG.slice(CONFIG.indexOf('# BEGIN fixture allowlist'));
    expect(allowlist).toContain("paths = ['''^scripts/test/fixtures/secrets/''']");
    expect(CONFIG).not.toMatch(/regexes\s*=/);
  });

  it('strips exactly the fixture allowlist for the rule check', () => {
    const stripped = withoutFixtureAllowlist(CONFIG);
    expect(stripped).not.toContain('[[allowlists]]');
    expect(customRuleIds(stripped)).toEqual(customRuleIds(CONFIG));
    expect(() => withoutFixtureAllowlist('title = "x"')).toThrow(/markers/);
  });

  it('reports custom rules without findings', () => {
    expect(missingRules(CONFIG, [{ RuleID: 'agility-bridge-device-token' }])).toHaveLength(5);
  });
});
