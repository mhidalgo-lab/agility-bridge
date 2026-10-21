// SPDX-License-Identifier: Apache-2.0
// Master-key sources for `serve` (P2-03, ADR-0007, L-074, L-076).
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMasterKey } from '@agility-bridge/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.ts';
import { configDir, createMasterKeyFile, readMasterKeys } from '../src/master-key.ts';

const posix = process.platform !== 'win32';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ab-key-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function keyFile(name: string, content: string, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return path;
}

function configError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error('expected a ConfigError');
}

describe('readMasterKeys', () => {
  it('reads AB_MASTER_KEY or AB_MASTER_KEY_FILE, and the previous key during a rotation', () => {
    const k1 = generateMasterKey(1);
    const k2 = generateMasterKey(2);
    expect(readMasterKeys({ AB_MASTER_KEY: k1 })).toEqual({ current: k1 });
    const file = keyFile('master.key', `${k2}\n`);
    expect(readMasterKeys({ AB_MASTER_KEY_FILE: file, AB_MASTER_KEY_PREVIOUS: k1 })).toEqual({
      current: k2,
      previous: k1,
    });
    const prevFile = keyFile('previous.key', k1);
    expect(readMasterKeys({ AB_MASTER_KEY: k2, AB_MASTER_KEY_FILE_PREVIOUS: prevFile })).toEqual({
      current: k2,
      previous: k1,
    });
  });

  it('explains how to get a key when none is set', () => {
    const e = configError(() => readMasterKeys({ XDG_CONFIG_HOME: '/cfg' }));
    expect(e.message).toContain('agility-bridge init');
    expect(e.message).toContain('docs/guide/secrets.md');
  });

  it('refuses both a value and a file, and malformed keys without echoing them', () => {
    const k = generateMasterKey(1);
    expect(
      configError(() => readMasterKeys({ AB_MASTER_KEY: k, AB_MASTER_KEY_FILE: '/x' })).message,
    ).toContain('not both');
    const leaked = 'v1:not-a-real-key-but-still-secret-material';
    const e = configError(() => readMasterKeys({ AB_MASTER_KEY: leaked }));
    expect(e.message).not.toContain('still-secret');
    const file = keyFile('bad.key', leaked);
    expect(configError(() => readMasterKeys({ AB_MASTER_KEY_FILE: file })).message).not.toContain(
      'still-secret',
    );
  });

  it.runIf(posix)('refuses a key file readable by others, or a symbolic link to one', () => {
    const loose = keyFile('loose.key', generateMasterKey(1), 0o644);
    expect(configError(() => readMasterKeys({ AB_MASTER_KEY_FILE: loose })).message).toContain('chmod 600');
    const good = keyFile('good.key', generateMasterKey(1));
    symlinkSync(good, join(dir, 'link.key'));
    expect(
      configError(() => readMasterKeys({ AB_MASTER_KEY_FILE: join(dir, 'link.key') })).message,
    ).toContain('symbolic link');
  });

  it('refuses a key file inside the data directory (a backup would carry both)', () => {
    const data = join(dir, 'data');
    mkdirSync(data);
    const inside = join(data, 'master.key');
    writeFileSync(inside, generateMasterKey(1), { mode: 0o600 });
    expect(
      configError(() => readMasterKeys({ AB_MASTER_KEY_FILE: inside }, { dataDir: data })).message,
    ).toContain('inside the data directory');
    const outside = keyFile('master.key', generateMasterKey(1));
    expect(readMasterKeys({ AB_MASTER_KEY_FILE: outside }, { dataDir: data }).current).toMatch(/^v1:/);
  });

  it('a missing key file is a clear error', () => {
    expect(
      configError(() => readMasterKeys({ AB_MASTER_KEY_FILE: join(dir, 'nope.key') })).message,
    ).toContain('does not exist');
  });
});

describe('createMasterKeyFile', () => {
  it('writes a new 0600 key in a 0700 directory and never overwrites it', () => {
    const path = join(dir, 'config', 'agility-bridge', 'master.key');
    expect(createMasterKeyFile(path)).toBe(path);
    const key = readFileSync(path, 'utf8').trim();
    expect(key).toMatch(/^v1:[A-Za-z0-9+/]{43}=$/);
    expect(readMasterKeys({ AB_MASTER_KEY_FILE: path }).current).toBe(key);
    if (posix) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'config', 'agility-bridge')).mode & 0o777).toBe(0o700);
    }
    expect(configError(() => createMasterKeyFile(path)).message).toContain('already exists');
    expect(readFileSync(path, 'utf8').trim()).toBe(key);
  });

  it('defaults to the user configuration directory', () => {
    expect(configDir({ XDG_CONFIG_HOME: '/home/u/.cfg' }, 'linux', '/home/u')).toBe(
      join('/home/u/.cfg', 'agility-bridge'),
    );
    expect(configDir({}, 'darwin', '/Users/u')).toBe(join('/Users/u', '.config', 'agility-bridge'));
    expect(configDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u')).toBe(
      join('C:\\Users\\u\\AppData\\Roaming', 'agility-bridge'),
    );
  });
});
