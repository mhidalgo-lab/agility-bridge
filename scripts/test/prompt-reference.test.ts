// SPDX-License-Identifier: Apache-2.0
// P6-08: the committed prompt reference matches the manifest (CI fails when it is stale).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { render } from '../prompt-reference.ts';

describe('docs/reference/prompts.md', () => {
  it('is up to date with the prompt manifest (pnpm docs:prompts)', () => {
    expect(readFileSync(new URL('../../docs/reference/prompts.md', import.meta.url), 'utf8')).toBe(render());
  });
});
