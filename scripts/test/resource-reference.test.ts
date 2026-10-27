// SPDX-License-Identifier: Apache-2.0
// P6-09: the committed resource reference matches the manifest (CI fails when it is stale).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { render } from '../resource-reference.ts';

describe('docs/reference/resources.md', () => {
  it('is up to date with the resource manifest (pnpm docs:resources)', () => {
    expect(readFileSync(new URL('../../docs/reference/resources.md', import.meta.url), 'utf8')).toBe(
      render(),
    );
  });
});
