// SPDX-License-Identifier: Apache-2.0
// The OS keychain (P8-08, L-103, THREAT_MODEL T8): the platform code runs against fakes on every OS; the real keychain
// is only touched when AB_TEST_KEYCHAIN=1 (a developer machine, never CI).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  bindingAccount,
  DEFAULT_SERVICE,
  type KeychainBackend,
  KeychainError,
  keychainFor,
  nodeRunner,
  parseKeychainRef,
  type Runner,
  type RunResult,
  readBinding,
  readKeychainRef,
  writeBinding,
} from '../src/keychain.ts';

const SECRET = 'v1:Zm9vYmFyLXNlY3JldC12YWx1ZS1ub3QtcmVhbC0xMjM0NTY3OA==';

interface Call {
  file: string;
  args: readonly string[];
  input: string | undefined;
  env: Readonly<Record<string, string>> | undefined;
}

/** A runner that records calls and answers from a script: one result per call, in order. */
function scripted(...results: Partial<RunResult>[]): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const run: Runner = (file, args, input, env) => {
    calls.push({ file, args, input, env });
    return { status: 0, stdout: '', stderr: '', ...(results[i++] ?? {}) };
  };
  return { run, calls };
}

/** A runner for a fake store: the platform tool is modelled just enough to prove set, get and delete round trip. */
function store(platform: 'darwin' | 'linux' | 'win32'): {
  run: Runner;
  calls: Call[];
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  const calls: Call[] = [];
  const run: Runner = (file, args, input, env) => {
    calls.push({ file, args, input, env });
    const ok = (stdout = ''): RunResult => ({ status: 0, stdout, stderr: '' });
    if (platform === 'darwin') {
      if (args[0] === '-i') {
        const m = /-s "([^"]+)" -a "([^"]+)".* -X ([0-9a-f]+)\n$/.exec(input ?? '');
        if (m === null) return { status: 1, stdout: '', stderr: 'bad' };
        data.set(`${m[1]}/${m[2]}`, Buffer.from(m[3] as string, 'hex').toString('utf8'));
        return ok();
      }
      const key = `${args[args.indexOf('-s') + 1]}/${args[args.indexOf('-a') + 1]}`;
      if (args[0] === 'find-generic-password')
        return data.has(key)
          ? ok(`${data.get(key)}\n`)
          : { status: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' };
      if (args[0] === 'delete-generic-password')
        return data.delete(key) ? ok() : { status: 44, stdout: '', stderr: 'could not be found' };
      return ok();
    }
    if (platform === 'linux') {
      const at = (name: string) => args[args.indexOf(name) + 1];
      const key = `${at('service')}/${at('account')}`;
      if (args[0] === 'store') {
        data.set(key, input ?? '');
        return ok();
      }
      if (args[0] === 'lookup')
        return data.has(key) ? ok(data.get(key)) : { status: 1, stdout: '', stderr: '' };
      if (args[0] === 'clear') return data.delete(key) ? ok() : { status: 1, stdout: '', stderr: '' };
      return ok();
    }
    const key = env?.['AB_KEYCHAIN_TARGET'] ?? '';
    if (env?.['AB_KEYCHAIN_OP'] === 'set') {
      data.set(key, input ?? '');
      return ok();
    }
    if (env?.['AB_KEYCHAIN_OP'] === 'get')
      return data.has(key) ? ok(data.get(key)) : { status: 3, stdout: '', stderr: '' };
    if (env?.['AB_KEYCHAIN_OP'] === 'delete')
      return data.delete(key) ? ok() : { status: 3, stdout: '', stderr: '' };
    return ok();
  };
  return { run, calls, data };
}

const platforms = ['darwin', 'linux', 'win32'] as const;

describe('keychain references', () => {
  it('parses keychain:name and keychain:service/account, and ignores anything else', () => {
    expect(parseKeychainRef('keychain:agility-token')).toEqual({
      service: DEFAULT_SERVICE,
      account: 'agility-token',
    });
    expect(parseKeychainRef('keychain:agility/ann')).toEqual({ service: 'agility', account: 'ann' });
    expect(parseKeychainRef('1.NotAReference')).toBeUndefined();
    expect(parseKeychainRef('')).toBeUndefined();
  });

  it('refuses malformed references with a message that holds no value', () => {
    for (const bad of [
      'keychain:',
      'keychain:/x',
      'keychain:x/',
      `keychain:${'a'.repeat(101)}`,
      'keychain:a\nb',
    ]) {
      expect(() => parseKeychainRef(bad), bad).toThrow(KeychainError);
    }
  });
});

describe.each(platforms)('keychain backend: %s (fake tools)', (platform) => {
  it('stores, reads, replaces and deletes a secret, and the secret is never in argv', () => {
    const { run, calls, data } = store(platform);
    const kc = keychainFor(platform, run);
    kc.set('agility-bridge', 'token', SECRET);
    expect(data.size).toBe(1);
    expect(kc.get('agility-bridge', 'token')).toBe(SECRET);
    kc.set('agility-bridge', 'token', `${SECRET}2`);
    expect(kc.get('agility-bridge', 'token')).toBe(`${SECRET}2`);
    expect(kc.delete('agility-bridge', 'token')).toBe(true);
    expect(kc.delete('agility-bridge', 'token')).toBe(false);
    expect(kc.get('agility-bridge', 'token')).toBeUndefined();
    // Not as an argument, not in the hex form of one, and not in the child's environment.
    const hexForm = Buffer.from(SECRET).toString('hex');
    for (const c of calls) {
      const argv = [c.file, ...c.args].join(' ');
      expect(argv).not.toContain(SECRET);
      expect(argv).not.toContain(hexForm);
      expect(JSON.stringify(c.env ?? {})).not.toContain(SECRET);
    }
    // ...and it did go to the tool's standard input.
    const writes = calls.filter((c) => c.input !== undefined);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some((c) => (c.input ?? '').includes(SECRET) || (c.input ?? '').includes(hexForm))).toBe(
      true,
    );
  });

  it('records the host an entry is for in a sibling entry, on every backend, with no secret in argv (P8-31)', () => {
    const { run, calls, data } = store(platform);
    const kc = keychainFor(platform, run);
    const ref = { service: 'agility-bridge', account: 'agility-token' };
    expect(readBinding(kc, ref)).toBeUndefined();
    kc.set(ref.service, ref.account, SECRET);
    writeBinding(kc, ref, 'agility.example.com');
    expect(readBinding(kc, ref)).toBe('agility.example.com');
    expect(kc.get(ref.service, ref.account)).toBe(SECRET);
    expect([...data.keys()].sort()).toEqual([
      'agility-bridge/agility-token',
      `agility-bridge/${bindingAccount('agility-token')}`,
    ]);
    for (const c of calls) expect([c.file, ...c.args].join(' ')).not.toContain(SECRET);
    // A secret cannot be given the binding's name, nor any other name outside the alphabet.
    expect(() => kc.set('agility-bridge', 'x#host2', SECRET)).toThrow(KeychainError);
    expect(() => kc.set('agility-bridge', '#host', SECRET)).toThrow(KeychainError);
  });

  it('refuses names that need quoting, before any tool runs', () => {
    const { run, calls } = store(platform);
    const kc = keychainFor(platform, run);
    for (const bad of ['a b', 'a"b', "a'b", 'a;b', '-x', 'a\nb', '']) {
      expect(() => kc.set(bad, 'x', SECRET), bad).toThrow(KeychainError);
      expect(() => kc.set('svc', bad, SECRET), bad).toThrow(KeychainError);
    }
    expect(calls).toHaveLength(0);
  });

  it('a missing tool is an error that says so, never an empty value', () => {
    const { run } = scripted({ status: null, failure: 'ENOENT' });
    const kc = keychainFor(platform, run);
    expect(() => kc.get('agility-bridge', 'token')).toThrow(/not installed|Nothing falls back/);
  });

  it('a tool that fails is an error naming the exit status, not a missing entry', () => {
    const { run } = scripted({ status: 2, stderr: 'Cannot autolaunch D-Bus' });
    const kc = keychainFor(platform, run);
    expect(() => kc.get('agility-bridge', 'token')).toThrow(/failed \(exit 2\)/);
  });

  it('a store that did not keep the secret fails the read-back check', () => {
    // Every call "succeeds" but nothing is stored: the lookup then finds no entry.
    const run: Runner = (file) => ({
      status: platform === 'linux' ? 1 : platform === 'darwin' && file === 'security' ? 44 : 3,
      stdout: '',
      stderr: platform === 'darwin' ? 'could not be found' : '',
    });
    const kc = keychainFor(platform, (f, a, i, e) =>
      i !== undefined ? { status: 0, stdout: '', stderr: '' } : run(f, a, i, e),
    );
    expect(() => kc.set('agility-bridge', 'token', SECRET)).toThrow(/could not be stored and read back/);
  });

  it('readKeychainRef names the reference and the command to store it, and never a value', () => {
    const { run } = store(platform);
    const kc = keychainFor(platform, run);
    expect(() => readKeychainRef({ service: DEFAULT_SERVICE, account: 'absent' }, kc)).toThrow(
      /no entry "agility-bridge\/absent".*keychain set absent/,
    );
    kc.set(DEFAULT_SERVICE, 'present', SECRET);
    expect(readKeychainRef({ service: DEFAULT_SERVICE, account: 'present' }, kc)).toBe(SECRET);
  });
});

describe.each(platforms)('keychain availability is a probe, not a start: %s (Q-8)', (platform) => {
  it('is false when the tool starts but exits with an error, true when it answers', () => {
    const broken = scripted({ status: 2, stderr: 'Cannot autolaunch D-Bus without X11 $DISPLAY' });
    expect(keychainFor(platform, broken.run).available()).toBe(false);
    const missing = scripted({ failure: 'ENOENT', status: null });
    expect(keychainFor(platform, missing.run).available()).toBe(false);
    const working = platform === 'linux' ? scripted({ status: 1, stderr: '' }) : scripted({ status: 0 });
    expect(keychainFor(platform, working.run).available()).toBe(true);
  });
});

describe('keychain: platform specifics', () => {
  it('macOS adds through `security -i` with the secret as hex on standard input', () => {
    const { run, calls } = store('darwin');
    keychainFor('darwin', run).set('agility-bridge', 'token', SECRET);
    expect(calls[0]?.file).toBe('security');
    expect(calls[0]?.args).toEqual(['-i']);
    expect(calls[0]?.input).toContain(`-X ${Buffer.from(SECRET).toString('hex')}`);
  });

  it('Linux stores through `secret-tool store` with the secret on standard input', () => {
    const { run, calls } = store('linux');
    keychainFor('linux', run).set('agility-bridge', 'token', SECRET);
    expect(calls[0]).toMatchObject({ file: 'secret-tool', input: SECRET });
    expect(calls[0]?.args.slice(0, 1)).toEqual(['store']);
  });

  it('Windows runs a script from -EncodedCommand with the operation in the environment and the secret on stdin', () => {
    const { run, calls } = store('win32');
    keychainFor('win32', run).set('agility-bridge', 'token', SECRET);
    const set = calls[0];
    expect(set?.file).toBe('powershell.exe');
    expect(set?.args).toContain('-EncodedCommand');
    expect(set?.env).toMatchObject({ AB_KEYCHAIN_OP: 'set', AB_KEYCHAIN_TARGET: 'agility-bridge/token' });
    expect(set?.input).toBe(SECRET);
    const script = Buffer.from(set?.args.at(-1) ?? '', 'base64').toString('utf16le');
    expect(script).toContain('CredWrite');
    expect(script).toContain('[Console]::In.ReadToEnd()');
  });

  it('Windows sets UTF-8 on both pipes and refuses a non-ASCII secret it cannot prove it stores (Q-9)', () => {
    const { run, calls } = store('win32');
    const kc = keychainFor('win32', run);
    expect(() => kc.set('agility-bridge', 'token', 'pässword-with-umlaut')).toThrow(/only ASCII/);
    expect(calls).toHaveLength(0);
    kc.set('agility-bridge', 'token', SECRET);
    const script = Buffer.from(calls[0]?.args.at(-1) ?? '', 'base64').toString('utf16le');
    expect(script).toContain('[Console]::InputEncoding');
    expect(script).toContain('[Console]::OutputEncoding');
    expect(script.indexOf('InputEncoding')).toBeLessThan(script.indexOf('ReadToEnd'));
  });

  it('an unsupported platform is an error with an alternative, not a silent skip', () => {
    expect(() => keychainFor('freebsd')).toThrow(/no keychain support on freebsd.*environment variable/);
  });
});

// Opt-in: touches the real keychain of the machine running the tests (a prompt may appear on macOS).
describe.skipIf(process.env['AB_TEST_KEYCHAIN'] !== '1')(
  'keychain backend: this machine (AB_TEST_KEYCHAIN=1)',
  () => {
    it('round trips a secret through the real keychain and removes it', () => {
      const kc: KeychainBackend = keychainFor(process.platform, nodeRunner);
      const account = `doctest-${randomUUID().slice(0, 8)}`;
      try {
        kc.set('agility-bridge-test', account, SECRET);
        expect(kc.get('agility-bridge-test', account)).toBe(SECRET);
      } finally {
        kc.delete('agility-bridge-test', account);
      }
      expect(kc.get('agility-bridge-test', account)).toBeUndefined();
    });
  },
);
