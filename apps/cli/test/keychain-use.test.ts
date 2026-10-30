// SPDX-License-Identifier: Apache-2.0
// `keychain:` references and the `keychain` commands (P8-08, L-103, T8, L-026): fake keychain, no real store touched.
import { generateMasterKey } from '@agility-bridge/auth';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';
import { type KeychainBackend, KeychainError } from '../src/keychain.ts';
import { main } from '../src/main.ts';
import { readMasterKeys } from '../src/master-key.ts';

const URL_ = 'https://agility.example.com/Acme';
const TOKEN = '1.KeychainTestTokenNotReal0123456789AbCd';

function fakeKeychain(initial: Record<string, string> = {}): KeychainBackend & {
  data: Map<string, string>;
  reads: string[];
} {
  const data = new Map(Object.entries(initial));
  const reads: string[] = [];
  return {
    label: 'Fake keychain',
    data,
    reads,
    get(service, account) {
      reads.push(`${service}/${account}`);
      return data.get(`${service}/${account}`);
    },
    set(service, account, secret) {
      data.set(`${service}/${account}`, secret);
    },
    delete(service, account) {
      return data.delete(`${service}/${account}`);
    },
    available: () => true,
  };
}

const reader = (kc: KeychainBackend) => (service: string, account: string) => {
  const v = kc.get(service, account);
  if (v === undefined) throw new ConfigError(`no entry "${service}/${account}"`);
  return v;
};

describe('keychain references in configuration', () => {
  it('AB_AGILITY_TOKEN=keychain:<name> reads the default service; keychain:<service>/<account> of another service is refused in env', () => {
    const kc = fakeKeychain({ 'agility-bridge/work': TOKEN, 'team/ann': 'FAKE-ANN-TOKEN-0000' });
    const a = loadConfig(
      { AB_AGILITY_URL: URL_, AB_AGILITY_TOKEN: 'keychain:work' },
      { keychain: reader(kc) },
    );
    expect(a.kind === 'configured' && a.token.reveal()).toBe(TOKEN);
    // Another service is refused in an environment value (S-2): a project's client file must not read other apps' entries.
    expect(() =>
      loadConfig({ AB_AGILITY_URL: URL_, AB_AGILITY_TOKEN: 'keychain:team/ann' }, { keychain: reader(kc) }),
    ).toThrow(/AB_AGILITY_TOKEN: an environment value may refer only/);
    expect(kc.reads).toEqual(['agility-bridge/work']);
    const b = loadConfig(
      { AB_AGILITY_URL: URL_, AB_AGILITY_TOKEN: 'keychain:agility-bridge/work' },
      { keychain: reader(kc) },
    );
    expect(b.kind === 'configured' && b.token.reveal()).toBe(TOKEN);
  });

  it('a plain token is used as it is and the keychain is never asked', () => {
    const kc = fakeKeychain();
    const c = loadConfig({ AB_AGILITY_URL: URL_, AB_AGILITY_TOKEN: TOKEN }, { keychain: reader(kc) });
    expect(c.kind === 'configured' && c.token.reveal()).toBe(TOKEN);
    expect(kc.reads).toEqual([]);
  });

  it('a missing entry stops startup, names the reference and has no fallback to the literal text', () => {
    const kc = fakeKeychain();
    expect(() =>
      loadConfig({ AB_AGILITY_URL: URL_, AB_AGILITY_TOKEN: 'keychain:absent' }, { keychain: reader(kc) }),
    ).toThrow(/agility-bridge\/absent/);
  });

  it('refuses a malformed reference and an empty entry, without printing a value', () => {
    expect(() =>
      loadConfig({ AB_AGILITY_URL: URL_, AB_AGILITY_TOKEN: 'keychain:' }, { keychain: () => TOKEN }),
    ).toThrow(/AB_AGILITY_TOKEN: A keychain reference/);
    expect(() =>
      loadConfig({ AB_AGILITY_URL: URL_, AB_AGILITY_TOKEN: 'keychain:x' }, { keychain: () => '' }),
    ).toThrow(/entry is empty/);
  });

  it('the YAML form takes a bare name too', () => {
    const kc = fakeKeychain({ 'agility-bridge/yaml': TOKEN });
    const yaml = `version: 1\nworkspaces:\n  a:\n    instance: { url: ${URL_}, token: "\${keychain:yaml}" }\n`;
    const c = loadConfig(
      { AB_CONFIG: '/cfg.yaml' },
      {
        files: { read: () => ({ text: yaml, bytes: yaml.length, groupOrWorldReadable: false }) },
        keychain: reader(kc),
      },
    );
    expect(c.kind === 'configured' && c.token.reveal()).toBe(TOKEN);
  });
});

describe('keychain references for the master key', () => {
  it('AB_MASTER_KEY and AB_MASTER_KEY_PREVIOUS may be references', () => {
    const k1 = generateMasterKey(1);
    const k2 = generateMasterKey(2);
    const kc = fakeKeychain({ 'agility-bridge/master': k2, 'agility-bridge/old': k1 });
    expect(
      readMasterKeys(
        { AB_MASTER_KEY: 'keychain:master', AB_MASTER_KEY_PREVIOUS: 'keychain:old' },
        { keychain: reader(kc) },
      ),
    ).toEqual({ current: k2, previous: k1 });
  });

  it('a reference that holds something that is not a master key is refused without echoing it', () => {
    const kc = fakeKeychain({ 'agility-bridge/bad': 'not-a-master-key-but-secret-looking' });
    try {
      readMasterKeys({ AB_MASTER_KEY: 'keychain:bad' }, { keychain: reader(kc) });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain('secret-looking');
    }
  });

  it('the key file variable still excludes the variable, a reference included', () => {
    expect(() =>
      readMasterKeys(
        { AB_MASTER_KEY: 'keychain:x', AB_MASTER_KEY_FILE: '/nowhere' },
        { keychain: () => generateMasterKey(1) },
      ),
    ).toThrow(/not both/);
  });
});

async function cli(args: string[], kc: KeychainBackend | undefined, env: Record<string, string>, stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, {
    env,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    stdin: () => async () => stdin,
    ...(kc === undefined ? {} : { keychain: () => kc }),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('keychain commands', () => {
  it('set stores the secret from standard input and never prints it', async () => {
    const kc = fakeKeychain();
    const r = await cli(['keychain', 'set', 'work'], kc, {}, `${TOKEN}\n`);
    expect(r.code).toBe(0);
    expect(kc.data.get('agility-bridge/work')).toBe(TOKEN);
    expect(r.out + r.err).not.toContain(TOKEN);
    expect(JSON.parse(r.out)).toEqual({ stored: 'keychain:work' });
    expect(r.err).toContain('AB_AGILITY_TOKEN');
  });

  it('set refuses a secret as a flag and a name that needs quoting, storing nothing', async () => {
    const kc = fakeKeychain();
    expect((await cli(['keychain', 'set', 'work', '--token', TOKEN], kc, {})).code).toBe(2);
    expect((await cli(['keychain', 'set', 'wo rk'], undefined, {}, TOKEN)).code).toBe(1);
    expect((await cli(['keychain', 'set', 'work'], kc, {}, '  \n')).code).toBe(1);
    expect(kc.data.size).toBe(0);
  });

  it('status reports the backend and, with --name, only whether the entry exists', async () => {
    const kc = fakeKeychain({ 'agility-bridge/work': TOKEN });
    const some = await cli(['keychain', 'status', '--name', 'work'], kc, {});
    expect(JSON.parse(some.out)).toEqual({ backend: 'Fake keychain', available: true, entry: true });
    const none = await cli(['keychain', 'status', '--name', 'other'], kc, {});
    expect(JSON.parse(none.out)).toMatchObject({ entry: false });
    expect(some.out + none.out).not.toContain(TOKEN);
  });

  it('status exits 1 when the keychain cannot be used', async () => {
    const kc: KeychainBackend = { ...fakeKeychain(), available: () => false };
    const r = await cli(['keychain', 'status'], kc, {});
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ available: false });
  });

  it('delete removes an entry and says whether there was one', async () => {
    const kc = fakeKeychain({ 'agility-bridge/work': TOKEN });
    expect(JSON.parse((await cli(['keychain', 'delete', 'work'], kc, {})).out)).toEqual({ deleted: true });
    expect(JSON.parse((await cli(['keychain', 'delete', 'work'], kc, {})).out)).toEqual({ deleted: false });
  });

  it('a keychain failure is a message and exit 1, never a stack trace or an empty success', async () => {
    const kc: KeychainBackend = {
      ...fakeKeychain(),
      set() {
        throw new KeychainError('Fake keychain: secret-tool is not installed.');
      },
    };
    const r = await cli(['keychain', 'set', 'work'], kc, {}, TOKEN);
    expect(r.code).toBe(1);
    expect(r.err).toContain('not installed');
    expect(r.err).not.toContain(TOKEN);
  });

  it('init --keychain stores a new master key in the keychain, writes no file, and never overwrites', async () => {
    const kc = fakeKeychain();
    const r = await cli(['init', '--keychain', 'master'], kc, {});
    expect(r.code).toBe(0);
    const stored = kc.data.get('agility-bridge/master') ?? '';
    expect(stored).toMatch(/^v1:/);
    expect(r.out + r.err).not.toContain(stored);
    expect(JSON.parse(r.out)).toEqual({ masterKeyReference: 'keychain:master' });
    const again = await cli(['init', '--keychain', 'master'], kc, {});
    expect(again.code).toBe(1);
    expect(kc.data.get('agility-bridge/master')).toBe(stored);
  });
});
