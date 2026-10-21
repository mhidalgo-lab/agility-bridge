// SPDX-License-Identifier: Apache-2.0
// P1-13: the committed tool reference matches the registry (CI fails when it is stale).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { render } from '../tool-reference.ts';

describe('docs/reference/tools.md', () => {
  it('is up to date with the tool registry (pnpm docs:tools)', () => {
    expect(readFileSync(new URL('../../docs/reference/tools.md', import.meta.url), 'utf8')).toBe(render());
  });
});
