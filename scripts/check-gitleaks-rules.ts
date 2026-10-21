// SPDX-License-Identifier: Apache-2.0
// P0-04 (L-010): proves that every custom gitleaks rule in .gitleaks.toml fires on its planted fake in
// scripts/test/fixtures/secrets/. The repository config allowlists that folder; this check scans it with a copy of the
// config that has the fixture allowlist removed, and fails unless each custom rule id is reported at least once.
// Usage: node scripts/check-gitleaks-rules.ts <path to gitleaks binary>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BEGIN = '# BEGIN fixture allowlist';
const END = '# END fixture allowlist';

/** The config without the block between the fixture-allowlist markers; throws if the markers are missing. */
export function withoutFixtureAllowlist(config: string): string {
  const start = config.indexOf(BEGIN);
  const end = config.indexOf(END);
  if (start < 0 || end < start) throw new Error('fixture allowlist markers not found in .gitleaks.toml');
  return config.slice(0, start) + config.slice(end + END.length);
}

/** Ids of the rules defined in this config (not the default ruleset it extends). */
export function customRuleIds(config: string): string[] {
  return [...config.matchAll(/^\[\[rules\]\]\s*\nid\s*=\s*"([^"]+)"/gm)].map((m) => m[1] ?? '');
}

/** Custom rule ids with no finding in a gitleaks JSON report. */
export function missingRules(config: string, report: Array<{ RuleID: string }>): string[] {
  const found = new Set(report.map((f) => f.RuleID));
  return customRuleIds(config).filter((id) => !found.has(id));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const gitleaks = process.argv[2];
  if (!gitleaks) {
    console.error('usage: node scripts/check-gitleaks-rules.ts <gitleaks binary>');
    process.exit(2);
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const config = readFileSync(join(root, '.gitleaks.toml'), 'utf8');
  const tmp = mkdtempSync(join(tmpdir(), 'ab-gitleaks-'));
  try {
    writeFileSync(join(tmp, 'config.toml'), withoutFixtureAllowlist(config));
    execFileSync(
      gitleaks,
      [
        'dir',
        join(root, 'scripts', 'test', 'fixtures', 'secrets'),
        '--config',
        join(tmp, 'config.toml'),
        '--report-format',
        'json',
        '--report-path',
        join(tmp, 'report.json'),
        '--exit-code',
        '0',
        '--no-banner',
        '--log-level',
        'warn',
      ],
      { stdio: 'inherit' },
    );
    const missing = missingRules(config, JSON.parse(readFileSync(join(tmp, 'report.json'), 'utf8')));
    for (const id of missing)
      console.error(`✗ custom gitleaks rule "${id}" did not fire on its planted fixture`);
    if (missing.length === 0)
      console.error(`✓ all ${customRuleIds(config).length} custom gitleaks rules fire on their fixtures`);
    process.exitCode = missing.length === 0 ? 0 : 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
