// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { render } from '../cli-reference.ts';

describe('docs/reference/cli.md', () => {
  it('is generated from the command table (pnpm docs:cli)', () => {
    expect(readFileSync(new URL('../../docs/reference/cli.md', import.meta.url), 'utf8')).toBe(render());
  });
});
