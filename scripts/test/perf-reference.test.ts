// SPDX-License-Identifier: Apache-2.0
// P9-03: the committed performance reference matches its inputs and covers every read tool (CI fails when it is stale).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CORE_TOOLS } from '../../packages/core/src/index.ts';
import { render } from '../perf-reference.ts';

describe('docs/reference/performance.md', () => {
  it('is up to date with the committed measurements (pnpm docs:perf)', () => {
    expect(readFileSync(new URL('../../docs/reference/performance.md', import.meta.url), 'utf8')).toBe(
      render(),
    );
  });

  it('has a row for every read tool, with its declared cost', () => {
    const text = render();
    for (const t of CORE_TOOLS.filter((x) => x.kind === 'read'))
      expect(text).toContain(`| \`${t.name}\` | ${t.cost} |`);
  });
});
