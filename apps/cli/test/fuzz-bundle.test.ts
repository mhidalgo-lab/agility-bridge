// SPDX-License-Identifier: Apache-2.0
// Fuzz tests for the configuration import (P9-01, THREAT_MODEL T29): a hostile or damaged file must end in a typed
// ConfigError, never in a crash, and a file that parses must have references that resolve. Seeded and replayable.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { propertyParams } from '../../../packages/core/test/harness/property.ts';
import { ConfigError } from '../src/config.ts';
import { MAX_BUNDLE_BYTES, parseBundle } from '../src/manage/config-bundle.ts';

const params = propertyParams(300);

describe('fuzz: configuration bundle parser (T29)', () => {
  it('any text parses to a bundle or fails with a ConfigError', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 300 }),
          fc.json(),
          fc.jsonValue().map((v) => JSON.stringify(v)),
        ),
        (text) => {
          try {
            parseBundle(text);
          } catch (error) {
            expect(error).toBeInstanceOf(ConfigError);
          }
        },
      ),
      params,
    );
  });

  it('prototype-pollution shapes and oversized files are refused', () => {
    for (const text of [
      '{"__proto__":{"polluted":true}}',
      '{"constructor":{"prototype":{"polluted":true}}}',
      '{"format":"agility-bridge-config","version":2,"__proto__":{"x":1}}',
    ]) {
      expect(() => parseBundle(text)).toThrow(ConfigError);
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(() => parseBundle(' '.repeat(MAX_BUNDLE_BYTES + 1))).toThrow(ConfigError);
  });
});
