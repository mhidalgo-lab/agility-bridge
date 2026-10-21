// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { render } from '../admin-api-reference.ts';

describe('docs/reference/admin-api.md', () => {
  it('is generated from the admin API (pnpm docs:admin-api)', () => {
    expect(readFileSync(new URL('../../docs/reference/admin-api.md', import.meta.url), 'utf8')).toBe(
      render(),
    );
  });
});
