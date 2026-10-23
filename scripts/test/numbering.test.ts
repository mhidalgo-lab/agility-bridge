// SPDX-License-Identifier: Apache-2.0
// Numbering of lessons (P4-11, L-241): every lesson has exactly one heading and is listed in the theme index at the top
// of LESSONS-LEARNED.md; a decision number appears once per phase file (the Phase 0 and Phase 1 files reuse D-20 and
// D-21, which are history and never renumbered, so those two are the only accepted repeats).
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../', import.meta.url);
const lessons = readFileSync(new URL('docs/LESSONS-LEARNED.md', ROOT), 'utf8');

describe('lesson numbering', () => {
  const headings = [...lessons.matchAll(/^\*\*L-(\d+)\b/gm)].map((m) => Number(m[1]));

  it('has no repeated lesson heading', () => {
    expect(headings.filter((n, i) => headings.indexOf(n) !== i)).toEqual([]);
  });

  it('lists every lesson in the theme index, and nothing else', () => {
    const covered = new Set<number>();
    for (const row of lessons.matchAll(/^\| \[[^\]]+\]\([^)]*\) \| ([^|]+) \|$/gm)) {
      for (const part of (row[1] ?? '').split(',')) {
        const range = /L-(\d+)\s*[–-]\s*L-(\d+)/.exec(part);
        if (range) {
          for (let n = Number(range[1]); n <= Number(range[2]); n++) covered.add(n);
        } else {
          const one = /L-(\d+)/.exec(part);
          if (one) covered.add(Number(one[1]));
        }
      }
    }
    const have = new Set(headings);
    expect([...have].filter((n) => !covered.has(n))).toEqual([]);
    expect([...covered].filter((n) => !have.has(n))).toEqual([]);
  });
});

describe('decision numbering', () => {
  it('repeats a number across phase files only for the two historical D-20 and D-21', () => {
    const seen = new Map<number, string[]>();
    for (const f of readdirSync(new URL('docs/pending-decisions/', ROOT))) {
      if (!f.endsWith('.md')) continue;
      const text = readFileSync(new URL(`docs/pending-decisions/${f}`, ROOT), 'utf8');
      const own = [...text.matchAll(/^### D-(\d+)\b/gm)].map((m) => Number(m[1]));
      expect(
        own.filter((n, i) => own.indexOf(n) !== i),
        `${f} repeats a decision`,
      ).toEqual([]);
      for (const n of own) seen.set(n, [...(seen.get(n) ?? []), f]);
    }
    const repeated = [...seen].filter(([, files]) => files.length > 1).map(([n]) => n);
    expect(repeated).toEqual([20, 21]);
  });
});
