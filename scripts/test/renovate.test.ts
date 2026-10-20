// SPDX-License-Identifier: Apache-2.0
// P0-04: Renovate's regex manager must find every CI tool pinned by release tag and sha256, so the tag and the digest
// are updated together (L-130).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface RenovateConfig {
  minimumReleaseAge: string;
  customManagers: Array<{ matchStrings: string[] }>;
  packageRules: Array<{ matchUpdateTypes?: string[]; dependencyDashboardApproval?: boolean }>;
}

const config = JSON.parse(
  readFileSync(new URL('../../renovate.json', import.meta.url), 'utf8'),
) as RenovateConfig;
const workflow = (name: string): string =>
  readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');

describe('renovate.json', () => {
  it('waits 3 days for new releases and needs approval for majors', () => {
    expect(config.minimumReleaseAge).toBe('3 days');
    expect(config.packageRules).toContainEqual(
      expect.objectContaining({ matchUpdateTypes: ['major'], dependencyDashboardApproval: true }),
    );
  });

  it.each([
    ['ci.yml', 'rhysd/actionlint'],
    ['security.yml', 'gitleaks/gitleaks'],
  ])('finds the tag and sha256 pin in %s (%s)', (file, depName) => {
    const re = new RegExp(config.customManagers[0]?.matchStrings[0] ?? '', 'g');
    const matches = [...workflow(file).matchAll(re)];
    expect(matches).toHaveLength(1);
    expect(matches[0]?.groups).toMatchObject({
      datasource: 'github-release-attachments',
      depName,
      currentValue: expect.stringMatching(/^v\d+\.\d+\.\d+$/),
      currentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});
