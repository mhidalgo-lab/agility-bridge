// SPDX-License-Identifier: Apache-2.0
// The guides keep their walkthrough markers (P2-16): steps 1..n, contiguous, each with commands. CI runs them in a
// fresh container (scripts/walkthrough.ts in the Docker job).
import { describe, expect, it } from 'vitest';
import { script, walkthroughBlocks } from '../walkthrough.ts';

describe('self-hosting walkthrough', () => {
  it('finds the marked steps in order, from install to a device token', () => {
    const blocks = walkthroughBlocks();
    expect(blocks.map((b) => b.step)).toEqual(blocks.map((_, i) => i + 1));
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    const all = blocks.flatMap((b) => b.lines).join('\n');
    for (const needed of [
      'npm install -g agility-bridge',
      'agility-bridge init',
      'agility-bridge token issue',
      'agility-bridge serve',
    ]) {
      expect(all).toContain(needed);
    }
  });

  it('substitutes only the package, the example URLs and the ids, and never prints a device token', () => {
    const s = script('/pkg/agility-bridge-9.9.9.tgz');
    expect(s).toContain('npm install -g /pkg/agility-bridge-9.9.9.tgz');
    expect(s).not.toContain('www7.v1host.com/YourInstance\n');
    expect(s).toContain('"$INSTANCE_ID"');
    expect(s).toContain('[REDACTED]');
  });
});
