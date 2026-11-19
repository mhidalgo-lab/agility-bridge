// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { consoleLevelSink, createLogger, type LogLevel, stderrSink } from '../src/index.ts';

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

  it("passes each record's level to the sink", () => {
    const seen: LogLevel[] = [];
    const log = createLogger({ level: 'debug', sink: (_l, level) => seen.push(level) });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(seen).toEqual(['debug', 'info', 'warn', 'error']);
  });
});

describe('sinks', () => {
  afterEach(() => vi.restoreAllMocks());

  const spies = () => ({
    debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
    info: vi.spyOn(console, 'info').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
  });

  it('consoleLevelSink writes each level with its own console method (Workers Logs, P9-28)', () => {
    const s = spies();
    const log = createLogger({ level: 'debug', sink: consoleLevelSink });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    for (const [method, msg] of [
      ['debug', 'd'],
      ['info', 'i'],
      ['warn', 'w'],
      ['error', 'e'],
    ] as const) {
      expect(s[method]).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(s[method].mock.calls[0]?.[0])) as unknown).toMatchObject({
        level: method,
        msg,
      });
    }
    expect(s.log).not.toHaveBeenCalled();
  });

  it('stderrSink keeps every level on console.error (stdout is the stdio MCP channel)', () => {
    const s = spies();
    const log = createLogger({ level: 'debug', sink: stderrSink });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(s.error).toHaveBeenCalledTimes(4);
    for (const m of ['debug', 'info', 'warn', 'log'] as const) expect(s[m]).not.toHaveBeenCalled();
  });
});
