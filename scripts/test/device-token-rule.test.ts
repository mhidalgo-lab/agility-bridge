// SPDX-License-Identifier: Apache-2.0
// P2-05: the gitleaks rule from P0-04 and the log redaction recognise generated device tokens (T8).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateDeviceToken } from '../../packages/auth/src/index.ts';
import { redact } from '../../packages/core/src/index.ts';

describe('generated device tokens', () => {
  it('match the gitleaks device-token rule and are redacted from logs', async () => {
    const config = readFileSync(new URL('../../.gitleaks.toml', import.meta.url), 'utf8');
    const rule = /id = "agility-bridge-device-token"[\s\S]*?regex = '''(.+?)'''/.exec(config)?.[1];
    expect(rule).toBeDefined();
    const re = new RegExp(rule as string);
    for (const env of ['live', 'test'] as const) {
      for (let i = 0; i < 50; i++) {
        const { token } = await generateDeviceToken(env);
        expect(re.test(`AB_TOKEN=${token}`), token.slice(0, 12)).toBe(true);
        expect(redact(`Authorization: Bearer ${token}`)).not.toContain(token.slice(8, 30));
        expect(redact(`device ${token} used`)).not.toContain(token.slice(8, 30));
      }
    }
  });
});
