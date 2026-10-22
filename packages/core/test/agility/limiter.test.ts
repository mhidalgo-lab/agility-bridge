// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { CredentialLimiters } from '../../src/agility/limiter.ts';

describe('CredentialLimiters', () => {
  it('shares one semaphore per instance and credential in a process', () => {
    const l = new CredentialLimiters();
    expect(l.for('i', 'c')).toBe(l.for('i', 'c'));
    expect(l.for('i', 'c')).not.toBe(l.for('i', 'd'));
  });

  it('perCall (Workers, L-096) never shares one: no call waits for a slot another request holds', async () => {
    const l = new CredentialLimiters({ concurrency: 1, perCall: true });
    expect(l.for('i', 'c')).not.toBe(l.for('i', 'c'));
    let release = () => {};
    const held = l.for('i', 'c').run(() => new Promise<void>((r) => (release = r)));
    let ran = false;
    await l.for('i', 'c').run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    release();
    await held;
  });
});
