// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { main } from '../src/main.ts';

describe('cli placeholder', () => {
  it('prints its version to stderr and exits 0', () => {
    const lines: string[] = [];
    expect(main((line) => lines.push(line))).toBe(0);
    expect(lines).toEqual([`agility-bridge ${pkg.version}`]);
  });
});
