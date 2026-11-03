// SPDX-License-Identifier: Apache-2.0
// The threat-model evidence map stays true (P9-01, L-010, L-483): every threat row has an evidence row, every path in
// it exists, every quoted test title is in a test file named in the same row, and every residual or live item it cites
// is defined.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const model = read('docs/THREAT_MODEL.md');
const evidence = read('docs/security/threat-evidence.md');

/** Ids of the threat rows of sections 5 and 6 of the threat model (`| T12 | …`, `| A3 | …` with a threat text). */
const THREATS = [...new Set([...model.matchAll(/^\| ((?:T|A)\d+) \|/gm)].map((m) => m[1] as string))].filter(
  (id) =>
    (Number(id.slice(1)) <= 35 && id.startsWith('T')) || (Number(id.slice(1)) <= 15 && id.startsWith('A')),
);

interface Row {
  readonly id: string;
  readonly code: string;
  readonly tests: string;
  readonly level: string;
  readonly rest: string;
}

const rows = new Map<string, Row>();
for (const line of evidence.split('\n')) {
  const cells = line.split(/ \| /).map((c) => c.replace(/^\| /, '').replace(/ \|$/, '').trim());
  const id = cells[0];
  if (cells.length === 5 && id !== undefined && /^(T|A)\d+$/.test(id)) {
    rows.set(id, {
      id,
      code: cells[1] as string,
      tests: cells[2] as string,
      level: cells[3] as string,
      rest: cells[4] as string,
    });
  }
}

const paths = (text: string) => [...text.matchAll(/`([^`\s]+\/[^`\s]+)`/g)].map((m) => m[1] as string);

describe('threat evidence map', () => {
  it('knows the threat rows of the model (35 T and 15 A)', () => {
    expect(THREATS.filter((t) => t.startsWith('T'))).toHaveLength(35);
    expect(THREATS.filter((t) => t.startsWith('A'))).toHaveLength(15);
  });

  it('has exactly one evidence row for every threat, and none for an unknown one', () => {
    expect([...rows.keys()].sort()).toEqual([...THREATS].sort());
  });

  it('gives every row code, tests and a level', () => {
    for (const row of rows.values()) {
      expect(paths(row.code).length, `${row.id} code`).toBeGreaterThan(0);
      expect(paths(row.tests).length, `${row.id} tests`).toBeGreaterThan(0);
      expect(['A', 'A+L', 'P'], `${row.id} level`).toContain(row.level);
    }
  });

  it('points only at files that exist', () => {
    for (const row of rows.values()) {
      for (const p of [...paths(row.code), ...paths(row.tests)]) {
        expect(existsSync(join(ROOT, p)), `${row.id}: ${p}`).toBe(true);
      }
    }
  });

  it('quotes only test titles that are in a test file named in the same row', () => {
    for (const row of rows.values()) {
      const files = paths(row.tests).map(read);
      for (const title of [...row.tests.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string)) {
        expect(
          files.some((f) => f.includes(title)),
          `${row.id}: "${title}"`,
        ).toBe(true);
      }
    }
  });

  it('defines every residual risk and live item it cites, and each live item is cited by some row', () => {
    const defined = (prefix: string) =>
      new Set(
        [...evidence.matchAll(new RegExp(`^\\| (${prefix}-\\d+) \\|`, 'gm'))].map((m) => m[1] as string),
      );
    const risks = defined('R');
    const live = defined('L');
    const cited = new Set<string>();
    for (const row of rows.values()) {
      for (const ref of row.rest.match(/\b[RL]-\d+\b/g) ?? []) {
        cited.add(ref);
        expect((ref.startsWith('R') ? risks : live).has(ref), `${row.id} cites ${ref}`).toBe(true);
      }
      if (row.level === 'A+L') expect(row.rest, `${row.id} names what is unproven`).toMatch(/\bL-\d+\b/);
    }
    for (const id of [...risks, ...live]) expect(cited.has(id), `${id} is cited`).toBe(true);
  });

  it('is linked from the threat model', () => {
    expect(model).toContain('security/threat-evidence.md');
  });
});
