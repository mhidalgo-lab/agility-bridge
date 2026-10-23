// SPDX-License-Identifier: Apache-2.0
// Redaction corpus (L-117, THREAT_MODEL T8): every secret shape must go, every benign word must survive.
import { describe, expect, it } from 'vitest';
import { REDACTED, redact, redactValue, Secret } from '../src/index.ts';

// Fakes are assembled at run time so no secret-shaped literal sits in the repository (gitleaks allowlists by path only).
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
let seed = 7;
const fake = (n: number, alphabet = B62): string => {
  let out = '';
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out += alphabet[seed % alphabet.length];
  }
  return out;
};
const B64 = `${B62}+/`;
const AB = 'ab_';
const BEGIN = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
const END = ['-----END', 'RSA PRIVATE KEY-----'].join(' ');

/** [name, input, the secret part that must disappear]. */
const SECRETS: Array<[string, string, string]> = [];
const add = (name: string, secret: string, render: (s: string) => string) =>
  SECRETS.push([name, render(secret), secret]);
add('bearer header', `1.${fake(28, B64)}==`, (s) => `Authorization: Bearer ${s}`);
add('bearer in text', `1.${fake(28, B64)}=`, (s) => `sent Bearer ${s} to the API`);
add('digest in JSON', fake(12), (s) => `{"Authorization": "Digest username=\\"u\\", response=\\"${s}\\""}`);
add('basic auth', fake(24, B64), (s) => `Authorization: Basic ${s}`);
add('custom scheme', fake(20), (s) => `Authorization: V1Token ${s}`);
add('proxy authorization', fake(12), (s) => `Proxy-Authorization: Digest username="u", response="${s}"`);
add('device token', `${fake(43)}_${fake(6)}`, (s) => `token ${AB}live_${s}`);
add('test device token', `${fake(43)}_${fake(6)}`, (s) => `${AB}test_${s}`);
add('admin token', fake(40), (s) => `AB_ADMIN_TOKEN=${AB}admin_${s}`);
add('owner setup code', fake(64, '0123456789abcdef'), (s) => `setup ${AB}setup_${s}`);
add(
  'owner setup URL',
  fake(64, '0123456789abcdef'),
  (s) => `https://bridge.example.test/auth/setup#${AB}setup_${s}`,
);
add('master key', fake(43, B64), (s) => `master v2:${s}=`);
add('master key env', fake(43, B64), (s) => `AB_MASTER_KEY=${s}=`);
add('agility token env', `1.${fake(28, B64)}`, (s) => `AB_AGILITY_TOKEN=${s}=`);
add('URL credentials', fake(12), (s) => `https://alice:${s}@agility.example.com/Inst`);
add('access_token parameter', fake(20), (s) => `https://example.com/cb?code=x&access_token=${s}&state=y`);
add('x-api-key JSON', fake(18), (s) => `{"x-api-key": "k-${s}"}`);
add('DB_PASSWORD style', fake(16), (s) => `DB_PASSWORD=${s}`);
add('client_secret', fake(14), (s) => `client_secret: "s-${s}"`);
add('cookie', fake(16), (s) => `Cookie: session=${s}`);
add('JWT', fake(43), (s) => `id eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${s}`);
add('GitHub token', fake(36), (s) => `gh${'p'}_${s}`);
add('PEM', fake(40, B64), (s) => `${BEGIN}\n${s}\n${END}`);

describe('redact', () => {
  it.each(SECRETS)('removes %s', (_name, input, secret) => {
    expect(redact(input)).not.toContain(secret);
  });

  it.each([
    'The backlog item B-01234 moved to In Progress.',
    'Tokens are never accepted as tool arguments.',
    'A password reset story for the login page',
    'secret santa planning (team event)',
    'The bearer of bad news',
    'Status.Name, Owners.Name, ChangeDate',
    'https://www7.v1host.com/SyntheticInstance/rest-1.v1/Data/Story/1001',
  ])('keeps benign text: %s', (input) => {
    expect(redact(input)).toBe(input);
  });

  it('is idempotent', () => {
    for (const [, s] of SECRETS) expect(redact(redact(s))).toBe(redact(s));
  });

  it('runs in linear time on hostile input', () => {
    const t = performance.now();
    redact(`${'a'.repeat(200_000)}=${'b'.repeat(200_000)}`);
    redact(`Bearer ${'x '.repeat(100_000)}`);
    expect(performance.now() - t).toBeLessThan(2_000);
  });
});

describe('redactValue and Secret', () => {
  it('blanks secret-named keys at any depth and keeps Secret values hidden', () => {
    const note = `1.${fake(24)}=`;
    const out = redactValue({
      user: 'alice',
      headers: { Authorization: 'Bearer x', 'x-api-key': 'k' },
      nested: [{ token: 't', note: `AB_AGILITY_TOKEN=${note}` }],
      cred: new Secret('FAKE-token'),
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toMatch(/FAKE-token/);
    expect(JSON.stringify(out)).not.toContain(note.slice(2, -1));
    expect(out['user']).toBe('alice');
    expect((out['headers'] as Record<string, unknown>)['Authorization']).toBe(REDACTED);
  });

  it('never prints a Secret through String, JSON or interpolation', () => {
    const s = new Secret('FAKE-token-value');
    expect(String(s)).toBe(REDACTED);
    expect(JSON.stringify({ s })).not.toContain('FAKE-token-value');
    expect(`${s}`).toBe(REDACTED);
    expect(s.reveal()).toBe('FAKE-token-value');
  });

  it('cuts cycles and depth', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    expect(redactValue(a)).toEqual({ name: 'a', self: '[CIRCULAR]' });
  });
});
