// SPDX-License-Identifier: Apache-2.0
// `agility-bridge doctor` (P8-04, THREAT_MODEL T28, L-077): read-only diagnosis of a setup. It never creates, migrates
// or edits anything; the only changes it can make are the `chmod` repairs it lists itself, and only with `--fix`.
// Every message is scrubbed of the secrets it could have seen, and values from client files are never printed.
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  Keyring,
  probeInstance,
  timingSafeEqual,
  type ValidationResult,
  validateAgilityToken,
} from '@agility-bridge/auth';
import { canonicalInstanceUrl, redact, silentLogger } from '@agility-bridge/core';
import { MIGRATIONS } from '@agility-bridge/storage';
import { createNodeFetch, type FetchLike } from './agility-fetch.ts';
import { ConfigError, checkEnvNames, type KeychainReader, loadConfig, type StdioConfig } from './config.ts';
import { readMasterKeys } from './master-key.ts';
import { dataDir, nodeHostServices } from './serve.ts';

export type Status = 'ok' | 'warn' | 'fail' | 'skip' | 'info';

/** One repair `--fix` may apply: a `chmod` of a regular file or directory. Nothing else is ever repaired. */
export interface FixAction {
  readonly path: string;
  readonly mode: number;
}

export interface Finding {
  readonly id: string;
  readonly status: Status;
  readonly message: string;
  readonly hint?: string;
  readonly fix?: FixAction;
}

export interface DoctorOptions {
  /** One authenticated request to Agility (explicit consent). */
  readonly checkToken: boolean;
  /** No network at all. */
  readonly offline: boolean;
  readonly fix: boolean;
}

export interface DoctorDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly cwd?: string;
  readonly nodeVersion?: string;
  readonly keychain?: KeychainReader;
  /** The fetch for the instance probe (tests); the default honours `AB_CA_FILE` and the private-address policy. */
  readonly fetchFor?: (o: { caFile?: string; publicOnly: boolean }) => FetchLike;
  /** The authenticated check (tests). */
  readonly validate?: (o: {
    baseUrl: string;
    caFile?: string;
    token: string;
    publicOnly: boolean;
  }) => Promise<ValidationResult>;
}

export interface DoctorReport {
  readonly findings: readonly Finding[];
  /** Repairs applied by `--fix`. */
  readonly fixed: readonly FixAction[];
}

const MAX_CLIENT_FILE = 1_048_576;
const MIN_NODE_MAJOR = 24;

/** Flags and values that must never sit in a client file's `args` (L-026). */
const SECRET_ARG = /^--?(?:token|agility[-_]?token|password|secret|api[-_]?key|master[-_]?key)\b/i;
const TOKEN_SHAPED = /^(?:ab_[A-Za-z0-9_-]{16,}|\d+\.[A-Za-z0-9+/=_-]{20,})$/;
const SECRET_ENV_NAME = /(?:TOKEN|SECRET|PASSWORD|API[-_]?KEY|MASTER[-_]?KEY)/i;

const finding = (
  id: string,
  status: Status,
  message: string,
  extra: { hint?: string; fix?: FixAction } = {},
): Finding => ({ id, status, message, ...extra });

/** Group- or world-accessible on POSIX; the repair is the owner-only mode. */
function modeFinding(
  id: string,
  path: string,
  kind: 'file' | 'dir',
  platform: NodeJS.Platform,
  what: string,
): Finding | undefined {
  if (platform === 'win32') return undefined;
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return undefined;
  }
  if (st.isSymbolicLink())
    return finding(id, 'warn', `${what} ${path} is a symbolic link; it is not checked or repaired.`);
  if ((st.mode & 0o077) === 0) return undefined;
  const want = kind === 'dir' ? 0o700 : 0o600;
  return finding(id, 'warn', `${what} ${path} is accessible by other users.`, {
    hint: `chmod ${want.toString(8)} ${path}`,
    fix: { path, mode: want },
  });
}

// --- runtime and configuration -----------------------------------------------------------------------------------

function runtimeChecks(deps: DoctorDeps): Finding[] {
  const version = deps.nodeVersion ?? process.versions.node;
  const major = Number(version.split('.')[0]);
  return [
    major >= MIN_NODE_MAJOR
      ? finding('runtime.node', 'ok', `Node ${version}.`)
      : finding(
          'runtime.node',
          'fail',
          `Node ${version} is too old; agility-bridge needs Node ${MIN_NODE_MAJOR} or newer.`,
          {
            hint: 'Install Node 24 LTS and restart your MCP client.',
          },
        ),
  ];
}

interface LoadedForDoctor {
  readonly config?: StdioConfig;
  readonly findings: Finding[];
}

function configChecks(deps: DoctorDeps): LoadedForDoctor {
  const findings: Finding[] = [];
  const warn = (m: string) => findings.push(finding('config.warning', 'warn', m));
  try {
    const loaded = loadConfig(deps.env, {
      warn,
      ...(deps.keychain === undefined ? {} : { keychain: deps.keychain }),
    });
    if (loaded.kind === 'setup') {
      findings.push(
        finding('config.stdio', 'info', 'No Agility configuration in this shell.', {
          hint: 'That is normal: your MCP client sets AB_AGILITY_URL and AB_AGILITY_TOKEN in its own env block (docs/guide/clients.md).',
        }),
      );
      return { findings };
    }
    findings.push(
      finding(
        'config.stdio',
        'ok',
        `Configuration read from ${loaded.source === 'yaml' ? 'AB_CONFIG' : 'the environment'}: workspace "${loaded.workspace.id}", instance ${loaded.instanceUrl}.`,
        {
          hint: 'This is the environment of this shell, which can differ from the one your client starts the server with.',
        },
      ),
    );
    const configFile = deps.env['AB_CONFIG'];
    if (configFile !== undefined && configFile !== '') {
      const f = modeFinding(
        'config.file-mode',
        configFile,
        'file',
        deps.platform ?? process.platform,
        'The configuration file',
      );
      if (f !== undefined) findings.push(f);
    }
    return { config: loaded, findings };
  } catch (error) {
    if (error instanceof ConfigError) {
      findings.push(finding('config.stdio', 'fail', error.message));
      return { findings };
    }
    throw error;
  }
}

// --- instance and token ------------------------------------------------------------------------------------------

async function instanceChecks(
  config: StdioConfig,
  opts: DoctorOptions,
  deps: DoctorDeps,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const publicOnly = deps.env['AB_INSTANCE_PRIVATE_ADDRESSES'] === 'refuse';
  const caFile = config.caFile;
  if (opts.offline) {
    findings.push(finding('instance.reach', 'skip', 'Network checks skipped (--offline).'));
    return findings;
  }
  let fetchImpl: FetchLike;
  try {
    fetchImpl =
      deps.fetchFor?.({ ...(caFile === undefined ? {} : { caFile }), publicOnly }) ??
      createNodeFetch({ ...(caFile === undefined ? {} : { caFile }), publicOnly });
  } catch (error) {
    findings.push(
      finding('instance.reach', 'fail', `The CA bundle cannot be used: ${(error as Error).message}`),
    );
    return findings;
  }
  const probe = await probeInstance(fetchImpl, config.instanceUrl);
  findings.push(
    probe.ok
      ? finding(
          'instance.reach',
          'ok',
          `${config.instanceUrl} answers like Agility over HTTPS (no credentials sent).`,
        )
      : finding('instance.reach', 'fail', probe.message, {
          hint: `Check the address you open Agility at (${probe.code}).`,
        }),
  );
  if (!opts.checkToken) {
    findings.push(
      finding('token.check', 'skip', 'The token was not checked.', {
        hint: 'Run with --check-token to send one authenticated request to your instance.',
      }),
    );
    return findings;
  }
  if (!probe.ok) {
    findings.push(
      finding('token.check', 'skip', 'The token was not checked: the instance did not pass the probe.'),
    );
    return findings;
  }
  const result = await (deps.validate ?? defaultValidate)({
    baseUrl: config.instanceUrl,
    ...(caFile === undefined ? {} : { caFile }),
    token: config.token.reveal(),
    publicOnly,
  });
  if (result.status === 'valid') {
    findings.push(
      finding(
        'token.check',
        'ok',
        `The token works and reaches ${result.reachableScopeIds.length} project(s).`,
      ),
    );
  } else {
    findings.push(
      finding('token.check', result.status === 'invalid' ? 'fail' : 'warn', result.message, {
        hint:
          result.status === 'invalid'
            ? 'Create a new access token on the Agility Applications page.'
            : 'Try again later.',
      }),
    );
  }
  return findings;
}

function defaultValidate(o: {
  baseUrl: string;
  caFile?: string;
  token: string;
  publicOnly: boolean;
}): Promise<ValidationResult> {
  const services = nodeHostServices(silentLogger, { publicOnly: o.publicOnly });
  return validateAgilityToken(
    services,
    { id: 'doctor', baseUrl: o.baseUrl, tls: o.caFile === undefined ? null : { caFile: o.caFile } },
    'doctor',
    o.token,
  );
}

// --- server data -------------------------------------------------------------------------------------------------

function openReadOnly(dbPath: string): DatabaseSync {
  // With a WAL file a server may be running: read through it. Without one nothing is pending, and `immutable` makes
  // SQLite take no lock and create no -shm or -wal side file, so the directory is left exactly as it was.
  if (existsSync(`${dbPath}-wal`)) return new DatabaseSync(dbPath, { readOnly: true });
  return new DatabaseSync(`${pathToFileURL(dbPath).href}?immutable=1`, { readOnly: true });
}

async function serverChecks(deps: DoctorDeps): Promise<Finding[]> {
  const env = deps.env;
  const platform = deps.platform ?? process.platform;
  const findings: Finding[] = [];
  const explicit = Boolean(env['AB_DB_PATH'] || env['AB_DATA_DIR']);
  const dbPath =
    env['AB_DB_PATH'] || join(env['AB_DATA_DIR'] || dataDir(env, platform, deps.home), 'agility-bridge.db');
  const keyVars = ['AB_MASTER_KEY', 'AB_MASTER_KEY_FILE'].some((k) => Boolean(env[k]));
  const exists = existsSync(dbPath);
  if (!exists && !explicit && !keyVars) {
    return [
      finding(
        'server.data',
        'skip',
        'No local server data (agility-bridge serve is not used on this machine).',
      ),
    ];
  }
  // Key files.
  for (const name of ['AB_MASTER_KEY_FILE', 'AB_MASTER_KEY_FILE_PREVIOUS', 'AB_ADMIN_TOKEN_FILE']) {
    const file = env[name];
    if (file === undefined || file === '') continue;
    const f = modeFinding(`server.${name.toLowerCase()}`, file, 'file', platform, `${name}:`);
    if (f !== undefined) findings.push(f);
  }
  let keyring: Keyring | undefined;
  try {
    const keys = readMasterKeys(env, { dataDir: dirname(dbPath) });
    keyring = await Keyring.create(keys.current, keys.previous);
    findings.push(
      finding(
        'server.master-key',
        'ok',
        `Master key loaded (version ${keyring.currentVersion}${keyring.versions.length > 1 ? ', previous key present' : ''}).`,
      ),
    );
  } catch (error) {
    const hint = 'agility-bridge init writes a new one; docs/guide/secrets.md explains how to keep it.';
    findings.push(
      keyVars || exists
        ? finding('server.master-key', 'fail', (error as Error).message, { hint })
        : finding('server.master-key', 'skip', (error as Error).message),
    );
  }
  if (!exists) {
    findings.push(
      finding(
        'server.database',
        'skip',
        `No database at ${dbPath} yet; \`agility-bridge serve\` creates it.`,
      ),
    );
    return findings;
  }
  const dirFinding = modeFinding(
    'server.data-dir-mode',
    dirname(dbPath),
    'dir',
    platform,
    'The data directory',
  );
  if (dirFinding !== undefined) findings.push(dirFinding);
  const fileFinding = modeFinding('server.database-mode', dbPath, 'file', platform, 'The database');
  if (fileFinding !== undefined) findings.push(fileFinding);
  if (lstatSync(dbPath).isSymbolicLink() || !lstatSync(dbPath).isFile()) {
    findings.push(finding('server.database', 'fail', `${dbPath} is not a regular file.`));
    return findings;
  }
  let db: DatabaseSync;
  try {
    db = openReadOnly(dbPath);
  } catch (error) {
    findings.push(
      finding(
        'server.database',
        'fail',
        `The database cannot be opened read-only: ${(error as Error).message}`,
      ),
    );
    return findings;
  }
  try {
    const check = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    if (check?.quick_check !== 'ok') {
      findings.push(
        finding('server.database', 'fail', 'SQLite reports the database as damaged.', {
          hint: 'Restore a backup (agility-bridge keys / docs/guide/self-hosting.md).',
        }),
      );
      return findings;
    }
    const has = (name: string) =>
      (
        db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) as {
          n: number;
        }
      ).n === 1;
    if (!has('schema_migrations')) {
      findings.push(finding('server.database', 'fail', 'The file is not an agility-bridge database.'));
      return findings;
    }
    const versions = (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    );
    const applied = Math.max(0, ...versions);
    if (applied > MIGRATIONS.length) {
      findings.push(
        finding(
          'server.database',
          'fail',
          `The database schema (version ${applied}) is newer than this agility-bridge (version ${MIGRATIONS.length}).`,
          {
            hint: 'Upgrade agility-bridge, or restore a backup made by this version.',
          },
        ),
      );
    } else if (applied < MIGRATIONS.length) {
      findings.push(
        finding(
          'server.database',
          'info',
          `The database is at schema ${applied}; ${MIGRATIONS.length - applied} migration(s) apply when the server next starts (doctor never migrates).`,
        ),
      );
    } else {
      findings.push(
        finding('server.database', 'ok', `Database readable, schema ${applied}, integrity check passed.`),
      );
    }
    if (keyring !== undefined && has('kv')) {
      const kcv = db.prepare('SELECT value FROM kv WHERE key = ?');
      for (const version of keyring.versions) {
        const row = kcv.get(`crypto:kcv:v${version}`) as { value: string } | undefined;
        if (row === undefined) continue;
        if (!timingSafeEqual(row.value, await keyring.keyCheckValue(version))) {
          findings.push(
            finding(
              'server.key-check',
              'fail',
              `Master key version ${version} is not the key this database was encrypted with.`,
              {
                hint: 'Use the original key; a version number can never be reused for a different key.',
              },
            ),
          );
          return findings;
        }
      }
      findings.push(
        finding('server.key-check', 'ok', 'The loaded master key matches the one recorded in the database.'),
      );
      if (has('credentials')) {
        const loaded = new Set(keyring.versions);
        const rows = db
          .prepare(
            'SELECT key_version AS v, count(*) AS n FROM credentials WHERE revoked_at IS NULL GROUP BY key_version',
          )
          .all() as { v: number; n: number }[];
        for (const r of rows.filter((x) => !loaded.has(x.v))) {
          findings.push(
            finding(
              'server.stranded-credentials',
              'warn',
              `${r.n} credential(s) use master key version ${r.v}, which is not loaded.`,
              {
                hint: 'Provide that key as AB_MASTER_KEY_PREVIOUS (a rotation) or enter those tokens again.',
              },
            ),
          );
        }
      }
    }
  } catch (error) {
    findings.push(
      finding('server.database', 'fail', `The database check failed: ${(error as Error).message}`),
    );
  } finally {
    db.close();
  }
  return findings;
}

// --- client files ------------------------------------------------------------------------------------------------

export interface ClientFile {
  readonly client: string;
  readonly path: string;
}

/** Where each primary client keeps MCP servers (docs/guide/clients.md). Paths that do not exist are skipped. */
export function clientFiles(
  env: DoctorDeps['env'],
  platform: NodeJS.Platform,
  home: string,
  cwd: string,
): ClientFile[] {
  const appData = env['APPDATA'] ?? join(home, 'AppData', 'Roaming');
  const xdg = env['XDG_CONFIG_HOME'] ?? join(home, '.config');
  const support = join(home, 'Library', 'Application Support');
  const userConfig = platform === 'win32' ? appData : platform === 'darwin' ? support : xdg;
  return [
    { client: 'Claude Code (project)', path: join(cwd, '.mcp.json') },
    { client: 'Claude Code (user)', path: join(home, '.claude.json') },
    { client: 'VS Code (workspace)', path: join(cwd, '.vscode', 'mcp.json') },
    { client: 'VS Code (user)', path: join(userConfig, 'Code', 'User', 'mcp.json') },
    { client: 'Copilot CLI', path: join(home, '.copilot', 'mcp-config.json') },
    { client: 'JetBrains Copilot', path: join(xdg, 'github-copilot', 'intellij', 'mcp.json') },
    { client: 'Claude Desktop', path: join(userConfig, 'Claude', 'claude_desktop_config.json') },
    { client: 'Cursor (user)', path: join(home, '.cursor', 'mcp.json') },
    { client: 'Cursor (project)', path: join(cwd, '.cursor', 'mcp.json') },
    { client: 'Windsurf', path: join(xdg, 'devin', 'mcp_config.json') },
    { client: 'Windsurf (old path)', path: join(home, '.codeium', 'windsurf', 'mcp_config.json') },
  ];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The server entries of a client file that are ours: `mcpServers`, `servers`, and Claude Code's per-project maps. */
function ourEntries(root: unknown): [string, Record<string, unknown>][] {
  if (!isRecord(root)) return [];
  const maps: unknown[] = [root['mcpServers'], root['servers']];
  if (isRecord(root['projects']))
    for (const p of Object.values(root['projects'])) if (isRecord(p)) maps.push(p['mcpServers']);
  const out: [string, Record<string, unknown>][] = [];
  for (const map of maps) {
    if (!isRecord(map)) continue;
    for (const [name, entry] of Object.entries(map)) {
      if (!isRecord(entry)) continue;
      const args = Array.isArray(entry['args']) ? entry['args'].map(String) : [];
      const command = typeof entry['command'] === 'string' ? basename(entry['command']) : '';
      const ours =
        /agility/i.test(name) || /agility-bridge/.test(command) || args.some((a) => /agility-bridge/.test(a));
      if (ours) out.push([name, entry]);
    }
  }
  return out;
}

function readSmall(path: string): string | 'symlink' | 'big' | 'unreadable' | undefined {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return undefined;
  }
  if (st.isSymbolicLink()) return 'symlink';
  if (!st.isFile()) return undefined;
  if (st.size > MAX_CLIENT_FILE) return 'big';
  try {
    const fd = openSync(path, 'r');
    try {
      if (fstatSync(fd).size > MAX_CLIENT_FILE) return 'big';
      const buffer = new Uint8Array(MAX_CLIENT_FILE);
      const n = readSync(fd, buffer, 0, buffer.length, 0);
      return new TextDecoder().decode(buffer.subarray(0, n));
    } finally {
      closeSync(fd);
    }
  } catch {
    return 'unreadable';
  }
}

function clientFindings(file: ClientFile, platform: NodeJS.Platform): Finding[] {
  const text = readSmall(file.path);
  if (text === undefined) return [];
  const id = `client.${file.client.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const where = `${file.client} (${file.path})`;
  if (text === 'symlink') return [finding(id, 'warn', `${where} is a symbolic link; it is not read.`)];
  if (text === 'big' || text === 'unreadable')
    return [finding(id, 'warn', `${where} could not be read (too large or no access).`)];
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return [finding(id, 'info', `${where} is not plain JSON (comments?); it was not checked.`)];
  }
  const entries = ourEntries(root);
  if (entries.length === 0) return [];
  const out: Finding[] = [];
  let plaintext = false;
  for (const [name, entry] of entries) {
    const label = `${where}, server "${name.slice(0, 40)}"`;
    const problems: string[] = [];
    const args = Array.isArray(entry['args']) ? entry['args'].map(String) : [];
    if (args.some((a) => SECRET_ARG.test(a) || TOKEN_SHAPED.test(a)))
      out.push(
        finding(
          `${id}.args`,
          'fail',
          `${label}: a secret is written in args, where process listings show it.`,
          {
            hint: "Remove it and use the env block with the client's variable or input prompt (docs/guide/clients.md).",
          },
        ),
      );
    const env = isRecord(entry['env']) ? entry['env'] : {};
    for (const [key, value] of Object.entries(env)) {
      if (
        SECRET_ENV_NAME.test(key) &&
        typeof value === 'string' &&
        value !== '' &&
        !/^\$\{[^}]+\}$/.test(value) &&
        !/^<.*>$/.test(value)
      ) {
        plaintext = true;
        problems.push(`${key} is stored in plain text`);
      }
    }
    const headers = isRecord(entry['headers'])
      ? entry['headers']
      : isRecord(entry['requestInit']) && isRecord(entry['requestInit']['headers'])
        ? entry['requestInit']['headers']
        : {};
    for (const [key, value] of Object.entries(headers)) {
      if (/^authorization$/i.test(key) && typeof value === 'string' && /^Bearer\s+(?!\$\{)\S+/i.test(value)) {
        plaintext = true;
        problems.push('the Authorization header is stored in plain text');
      }
    }
    const instance = env['AB_AGILITY_URL'];
    if (typeof instance === 'string' && !instance.startsWith('${')) {
      try {
        canonicalInstanceUrl(instance);
      } catch {
        out.push(
          finding(
            `${id}.url`,
            'fail',
            `${label}: AB_AGILITY_URL is not an accepted instance address (https:// only).`,
          ),
        );
      }
    }
    const url = entry['url'];
    if (
      typeof url === 'string' &&
      !/^https:\/\//i.test(url) &&
      !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(url)
    )
      out.push(finding(`${id}.url`, 'fail', `${label}: the server address is not https://.`));
    const abNames: Record<string, string> = {};
    for (const key of Object.keys(env)) if (key.startsWith('AB_')) abNames[key] = '';
    try {
      checkEnvNames(abNames);
    } catch (error) {
      out.push(finding(`${id}.env`, 'warn', `${label}: ${(error as Error).message}`));
    }
    if (problems.length > 0)
      out.push(
        finding(`${id}.plaintext`, 'warn', `${label}: ${problems.join('; ')}.`, {
          hint: "Prefer the client's input prompt or variable expansion (docs/guide/clients.md); keep the file owner-only.",
        }),
      );
  }
  if (plaintext) {
    const f = modeFinding(`${id}.mode`, file.path, 'file', platform, `${file.client} file`);
    if (f !== undefined) out.push(f);
  }
  if (out.length === 0)
    out.push(
      finding(id, 'ok', `${where}: the agility-bridge entry has no secret in args and no plain-text token.`),
    );
  return out;
}

// --- running -----------------------------------------------------------------------------------------------------

function secretsOf(deps: DoctorDeps, config?: StdioConfig): string[] {
  const values = ['AB_AGILITY_TOKEN', 'AB_MASTER_KEY', 'AB_MASTER_KEY_PREVIOUS', 'AB_ADMIN_TOKEN']
    .map((k) => deps.env[k])
    .filter((v): v is string => typeof v === 'string' && v.length >= 8);
  if (config !== undefined) values.push(config.token.reveal());
  for (const name of ['AB_MASTER_KEY_FILE', 'AB_MASTER_KEY_FILE_PREVIOUS', 'AB_ADMIN_TOKEN_FILE']) {
    const file = deps.env[name];
    if (file === undefined || file === '') continue;
    const content = readSmall(file);
    if (
      content !== undefined &&
      !['symlink', 'big', 'unreadable'].includes(content) &&
      content.trim().length >= 8
    )
      values.push(content.trim());
  }
  return values;
}

/** Removes every secret value this process knows, then the generic secret shapes. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  return redact(out);
}

export async function runDoctor(opts: DoctorOptions, deps: DoctorDeps): Promise<DoctorReport> {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const cwd = deps.cwd ?? process.cwd();
  const findings: Finding[] = [...runtimeChecks(deps)];
  const loaded = configChecks(deps);
  findings.push(...loaded.findings);
  if (loaded.config !== undefined) findings.push(...(await instanceChecks(loaded.config, opts, deps)));
  findings.push(...(await serverChecks(deps)));
  for (const file of clientFiles(deps.env, platform, home, cwd))
    findings.push(...clientFindings(file, platform));
  if (platform === 'win32')
    findings.push(
      finding(
        'files.modes',
        'info',
        'File-mode checks are skipped on Windows (access lists are not inspected).',
      ),
    );
  const secrets = secretsOf(deps, loaded.config);
  const clean = findings.map((f) => ({
    ...f,
    message: scrub(f.message, secrets),
    ...(f.hint === undefined ? {} : { hint: scrub(f.hint, secrets) }),
  }));
  const fixed: FixAction[] = [];
  if (opts.fix) {
    const done = new Set<string>();
    for (const f of clean) {
      if (f.fix === undefined || done.has(f.fix.path)) continue;
      done.add(f.fix.path);
      try {
        // One descriptor for the check and the change (no swap in between); O_NOFOLLOW refuses a link, which is
        // never a fix target.
        const fd = openSync(f.fix.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          fchmodSync(fd, f.fix.mode);
          fixed.push(f.fix);
        } finally {
          closeSync(fd);
        }
      } catch {
        // Reported by the unchanged finding on the next run.
      }
    }
  }
  return { findings: clean, fixed };
}

const MARK: Record<Status, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip', info: 'info' };

export function renderReport(report: DoctorReport, opts: DoctorOptions): string {
  const lines: string[] = [];
  for (const f of report.findings) {
    lines.push(`[${MARK[f.status]}] ${f.message}`);
    if (f.hint !== undefined) lines.push(`       ${f.hint}`);
  }
  const fixes = [
    ...new Map(
      report.findings.flatMap((f) => (f.fix === undefined ? [] : [[f.fix.path, f.fix] as const])),
    ).values(),
  ];
  if (report.fixed.length > 0) {
    lines.push('', 'Repaired:');
    for (const x of report.fixed) lines.push(`  chmod ${x.mode.toString(8)} ${x.path}`);
  } else if (fixes.length > 0 && !opts.fix) {
    lines.push('', 'Run `agility-bridge doctor --fix` to apply only these repairs:');
    for (const x of fixes) lines.push(`  chmod ${x.mode.toString(8)} ${x.path}`);
  }
  const count = (s: Status) => report.findings.filter((f) => f.status === s).length;
  lines.push('', `${count('ok')} ok, ${count('warn')} warning(s), ${count('fail')} failure(s).`);
  return lines.join('\n');
}

/** Exit code: 1 when any check failed. */
export const exitCode = (report: DoctorReport): number =>
  report.findings.some((f) => f.status === 'fail') ? 1 : 0;
