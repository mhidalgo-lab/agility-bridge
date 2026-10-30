// SPDX-License-Identifier: Apache-2.0
// Strict `traceparent` parsing (P8-07, T30): caller input is parsed field by field and never repaired.
import { describe, expect, it } from 'vitest';
import { hex, parseTraceparent } from '../../src/telemetry/index.ts';

const GOOD = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('parseTraceparent', () => {
  it('reads a valid version 00 header', () => {
    expect(parseTraceparent(GOOD)).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentSpanId: '00f067aa0ba902b7',
      flags: '01',
    });
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00')?.flags).toBe('00');
  });

  it.each([
    ['upper-case hex', GOOD.toUpperCase()],
    ['mixed-case trace id', '00-4BF92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
    ['version ff', 'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
    ['an unknown version', '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
    ['all-zero trace id', `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`],
    ['all-zero span id', `00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`],
    ['a short trace id', '00-4bf92f3577b34da6a3ce929d0e0e47-00f067aa0ba902b7-01'],
    ['a long span id', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7aa-01'],
    ['non-hex characters', '00-4bf92f3577b34da6a3ce929d0e0e47zz-00f067aa0ba902b7-01'],
    ['extra fields', `${GOOD}-extra`],
    ['trailing data without a dash', `${GOOD}0`],
    ['a leading space', ` ${GOOD}`],
    ['a trailing space', `${GOOD} `],
    ['a newline', `${GOOD}\n`],
    ['bad flags', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-zz'],
    ['missing flags', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7'],
    ['an empty string', ''],
  ])('refuses %s', (_name, value) => {
    expect(parseTraceparent(value)).toBeUndefined();
  });

  it('refuses non-strings', () => {
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent(null)).toBeUndefined();
    expect(parseTraceparent(5 as never)).toBeUndefined();
  });
});

describe('hex', () => {
  it('writes lower-case, zero-padded hex', () => {
    expect(hex(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff');
  });
});
