// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { main } from '../src/main.ts';

function run(args: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(args, { env, out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('main', () => {
  it('prints the version and the help', () => {
    expect(run(['--version'])).toMatchObject({ code: 0, out: `agility-bridge ${pkg.version}` });
    expect(run(['--help']).out).toContain('AB_AGILITY_URL');
  });

  it('refuses secrets as flags, and unknown arguments', () => {
    expect(run(['--token', 'x'])).toMatchObject({
      code: 2,
      err: expect.stringContaining('never takes secrets as flags'),
    });
    expect(run(['--agility-token=x']).code).toBe(2);
    expect(run(['serve', 'extra'])).toMatchObject({
      code: 2,
      err: expect.stringContaining('Unknown argument: serve'),
    });
    expect(run(['bogus'])).toMatchObject({
      code: 2,
      err: expect.stringContaining('Unknown argument: bogus'),
    });
  });

  it('admin-token prints one new generated token on stdout, with guidance on stderr', () => {
    const r = run(['admin-token']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^ab_admin_[0-9A-Za-z]{43}_[0-9A-Za-z]{6}$/);
    expect(run(['admin-token']).out).not.toBe(r.out);
    expect(r.err).toContain('AB_ADMIN_TOKEN_FILE');
  });

  it('serve without a master key exits 1 with guidance, before listening', async () => {
    const err: string[] = [];
    const code = main(['serve'], {
      env: { AB_DATA_DIR: '/nonexistent/agility-bridge-test', AB_PORT: '0' },
      out: () => {},
      err: (t) => err.push(t),
    });
    expect(await code).toBe(1);
    expect(err.join('\n')).toContain('agility-bridge init');
  });

  it('exits 1 with a clear message on partial or invalid configuration', () => {
    expect(run([], { AB_AGILITY_URL: 'https://agility.example.com/X' })).toMatchObject({
      code: 1,
      err: expect.stringContaining('AB_AGILITY_TOKEN is missing'),
    });
    expect(run([], { AB_AGILITY_TOKEN: 'FAKE' })).toMatchObject({
      code: 1,
      err: expect.stringContaining('AB_AGILITY_URL is missing'),
    });
    expect(
      run([], { AB_AGILITY_URL: 'http://agility.example.com/X', AB_AGILITY_TOKEN: 'FAKE' }).err,
    ).toContain('must use https://');
    expect(
      run([], {
        AB_AGILITY_URL: 'https://a.example.com/X',
        AB_AGILITY_TOKEN: 'FAKE',
        AB_TOOLS: 'whoami,list_everything',
      }),
    ).toMatchObject({
      code: 1,
      err: expect.stringMatching(
        /Unknown tool in AB_TOOLS: list_everything\. Valid tools: whoami, list_projects/,
      ),
    });
  });
});
