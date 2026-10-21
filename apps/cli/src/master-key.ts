// SPDX-License-Identifier: Apache-2.0
// Where `serve` gets its master key (ADR-0007, L-074): `AB_MASTER_KEY` or `AB_MASTER_KEY_FILE` (plus `_PREVIOUS`
// during a rotation), never a flag, never a file readable by others, never beside the database. `init` writes a new
// key to the user configuration directory, not the data directory.
import { closeSync, realpathSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { generateMasterKey, parseMasterKey, SecretsError } from '@agility-bridge/auth';
import {
  ensurePrivateDir,
  openPrivateFile,
  readSecretFile,
  UnsafeFileError,
} from '@agility-bridge/storage-sqlite';
import { ConfigError } from './config.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface MasterKeys {
  readonly current: string;
  readonly previous?: string;
}

/** The user configuration directory of agility-bridge (`$XDG_CONFIG_HOME` or `~/.config`; `%APPDATA%` on Windows). */
export function configDir(
  env: Env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const base =
    platform === 'win32'
      ? (env['APPDATA'] ?? join(home, 'AppData', 'Roaming'))
      : (env['XDG_CONFIG_HOME'] ?? join(home, '.config'));
  return join(base, 'agility-bridge');
}

/** Default master-key file written by `init`. */
export function defaultMasterKeyFile(env: Env): string {
  return join(configDir(env), 'master.key');
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** True when `file` is `dir` or inside it, after resolving links. */
function isInside(file: string, dir: string): boolean {
  const rel = relative(real(dir), real(file));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const FILE_VARIABLE = {
  AB_MASTER_KEY: 'AB_MASTER_KEY_FILE',
  AB_MASTER_KEY_PREVIOUS: 'AB_MASTER_KEY_FILE_PREVIOUS',
} as const;

function readOne(env: Env, name: keyof typeof FILE_VARIABLE, dataDir?: string): string | undefined {
  const fileName = FILE_VARIABLE[name];
  const value = env[name];
  const file = env[fileName];
  if (value !== undefined && value !== '' && file !== undefined && file !== '') {
    throw new ConfigError(`Set ${name} or ${fileName}, not both.`);
  }
  let key: string | undefined;
  if (file !== undefined && file !== '') {
    if (dataDir !== undefined && isInside(file, dataDir)) {
      throw new ConfigError(
        `${fileName} is inside the data directory; keep the master key away from the database and its backups.`,
      );
    }
    try {
      key = readSecretFile(file);
    } catch (error) {
      if (error instanceof UnsafeFileError) throw new ConfigError(`${fileName}: ${error.message}`);
      throw error;
    }
  } else if (value !== undefined && value !== '') {
    key = value;
  }
  if (key === undefined) return undefined;
  try {
    parseMasterKey(key);
  } catch (error) {
    if (error instanceof SecretsError) throw new ConfigError(`${name}: ${error.message}`);
    throw error;
  }
  return key.trim();
}

/** Reads and validates the master keys; `dataDir` is the directory of the database, which may not hold a key file. */
export function readMasterKeys(env: Env, options: { dataDir?: string } = {}): MasterKeys {
  const current = readOne(env, 'AB_MASTER_KEY', options.dataDir);
  if (current === undefined) {
    throw new ConfigError(
      `agility-bridge serve needs a master key to encrypt stored Agility tokens: run \`agility-bridge init\` and set ` +
        `AB_MASTER_KEY_FILE=${defaultMasterKeyFile(env)} (or AB_MASTER_KEY from your secret store). See docs/guide/secrets.md.`,
    );
  }
  const previous = readOne(env, 'AB_MASTER_KEY_PREVIOUS', options.dataDir);
  return previous === undefined ? { current } : { current, previous };
}

/**
 * Writes a new random master key (`v<version>:…`) to `path`, a file created exclusively with mode 0600 in a 0700
 * directory. Never overwrites: losing a key loses every token encrypted with it.
 */
export function createMasterKeyFile(path: string, version = 1): string {
  const target = resolve(path);
  ensurePrivateDir(dirname(target));
  let file: ReturnType<typeof openPrivateFile>;
  try {
    file = openPrivateFile(target, 'create');
  } catch (error) {
    if (error instanceof UnsafeFileError) throw new ConfigError(error.message);
    throw error;
  }
  try {
    const bytes = new TextEncoder().encode(`${generateMasterKey(version)}\n`);
    for (let off = 0; off < bytes.length; ) off += writeSync(file.fd, bytes, off);
  } finally {
    closeSync(file.fd);
  }
  return target;
}
