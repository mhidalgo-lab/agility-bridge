// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/index.ts';

describe('createLogger', () => {
  it('writes redacted JSON lines, honours the level and keeps reserved fields from being forged', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', sink: (l) => lines.push(l), now: () => 0 }).child({
      requestId: 'r1',
    });
    log.debug('hidden');
    log.info('called with Bearer 1.abcdefghijklmnopqrst=', {
      token: 'secret-value',
      level: 'error',
      msg: 'forged',
    });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(rec).toMatchObject({
      ts: '1970-01-01T00:00:00.000Z',
      level: 'info',
      requestId: 'r1',
      token: '[REDACTED]',
    });
    expect(rec['msg']).not.toContain('abcdefghijklmnopqrst');
    expect(rec['field_level']).toBe('error');
    expect(rec['field_msg']).toBe('forged');
  });

  it('never throws when the sink fails', () => {
    const log = createLogger({
      sink: () => {
        throw new Error('broken');
      },
    });
    expect(() => log.error('x')).not.toThrow();
  });
});
