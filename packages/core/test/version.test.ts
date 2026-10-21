// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import cli from '../../../apps/cli/package.json' with { type: 'json' };
import { VERSION } from '../src/index.ts';

describe('VERSION', () => {
  it('matches the published package version', () => {
    expect(VERSION).toBe(cli.version);
  });
});
