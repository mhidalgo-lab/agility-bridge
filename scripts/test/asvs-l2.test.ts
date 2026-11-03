// SPDX-License-Identifier: Apache-2.0
// The ASVS 5.0 Level 2 mapping and the OpenSSF answers stay complete and honest (P9-06, L-483, L-485): every Level 1 and
// 2 requirement exactly once, a known status, a reason or evidence on every row, every linked file present, and a task
// behind every Partly or Gap row.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const asvs = read('docs/security/asvs-l2.md');
const oss = read('docs/security/best-practices-answers.md');

const STATUSES = ['Met', 'Partly', 'Delegated', 'N/A', 'Gap'];
const rows = [...asvs.matchAll(/^\| (V\d+\.\d+\.\d+) \| ([12]) \| ([^|]+) \| (.+) \|$/gm)].map((m) => ({
  id: m[1] as string,
  level: m[2] as string,
  status: (m[3] as string).trim(),
  evidence: (m[4] as string).trim(),
}));

describe('ASVS 5.0 Level 2 mapping', () => {
  it('has one row for each of the 253 Level 1 and 2 requirements (70 and 183)', () => {
    expect(rows).toHaveLength(253);
    expect(new Set(rows.map((r) => r.id)).size).toBe(253);
    expect(rows.filter((r) => r.level === '1')).toHaveLength(70);
    expect(rows.filter((r) => r.level === '2')).toHaveLength(183);
  });

  it('uses known statuses, and a reason or evidence on every row', () => {
    for (const r of rows) {
      expect(STATUSES, r.id).toContain(r.status);
      expect(r.evidence.length, r.id).toBeGreaterThan(0);
    }
  });

  it('adds up the summary table', () => {
    for (const status of STATUSES) {
      const claimed = new RegExp(`^\\| ${status.replace('/', '\\/')} \\| [^|]+ \\| (\\d+) \\|$`, 'm').exec(
        asvs,
      );
      expect(Number(claimed?.[1]), status).toBe(rows.filter((r) => r.status === status).length);
    }
  });

  it('links only to files that exist', () => {
    const links = [
      ...asvs.matchAll(/\]\((\.\.\/\.\.\/[^)#\s]+|\.\.\/tasks\/[^)#\s]+|[a-z-]+\.md)(?:#[^)]*)?\)/g),
    ].map((m) => m[1] as string);
    expect(links.length).toBeGreaterThan(40);
    for (const link of new Set(links)) {
      expect(existsSync(join(ROOT, 'docs/security', link)), link).toBe(true);
    }
  });

  it('has a task behind the Partly and Gap rows', () => {
    const open = rows.filter((r) => r.status === 'Partly' || r.status === 'Gap');
    const task = 'docs/tasks/phase-9-hardening-launch/P9-09-asvs-partial-rows.md';
    expect(existsSync(join(ROOT, task))).toBe(true);
    const scope = read(task);
    for (const r of open) expect(scope, `${r.id} is in P9-09`).toContain(r.id.replace(/\.\d+$/, ''));
    expect(dirname(task)).toBeTruthy();
  });
});

describe('OpenSSF Best Practices answers', () => {
  const answers = [
    ...oss.matchAll(/^\| `([a-z0-9_]+)`: .+ \| (MUST|SHOULD|SUGGESTED) \| (Met|Unmet|N\/A) \| (.+) \|$/gm),
  ];

  it('answers all 67 passing-level criteria once', () => {
    expect(answers).toHaveLength(67);
    expect(new Set(answers.map((a) => a[1])).size).toBe(67);
  });

  it('has no unmet MUST, and a justification for every answer', () => {
    for (const a of answers) {
      expect(`${a[1]} ${a[2]} ${a[3]}`, 'unmet MUST').not.toMatch(/MUST Unmet/);
      expect((a[4] as string).length, `${a[1]} justification`).toBeGreaterThan(2);
    }
  });

  it('marks what only the owner can confirm', () => {
    expect(oss).toContain('*owner:*');
  });
});
