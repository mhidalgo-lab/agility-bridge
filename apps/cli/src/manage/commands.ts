// SPDX-License-Identifier: Apache-2.0
// Management commands (P2-10): one table drives parsing, help and the generated reference (docs/reference/cli.md).
// Every change goes through the admin API — remotely, or in process over the local database — so validation, guards
// and audit are the same on every path (L-065). Output is JSON on stdout; messages go to stderr.
import { generateAdminToken, generateMasterKey, rotateCredentialKeys } from '@agility-bridge/auth';
import { restoreSqliteBackup } from '@agility-bridge/storage-sqlite';
import { ConfigError } from '../config.ts';
import { exitCode, renderReport, runDoctor } from '../doctor.ts';
import { type KeychainBackend, KeychainError, type KeychainRef, parseKeychainRef } from '../keychain.ts';
import { createMasterKeyFile, defaultMasterKeyFile } from '../master-key.ts';
import type { AdminClient } from './client.ts';
import { readSecret } from './secret-input.ts';

export type OptionKind = 'string' | 'int' | 'flag' | 'list';

export interface OptionSpec {
  readonly name: string;
  readonly kind: OptionKind;
  readonly help: string;
  readonly repeat?: boolean;
  readonly required?: boolean;
}

export interface Parsed {
  readonly args: readonly string[];
  readonly opts: Readonly<Record<string, string | number | boolean | string[] | undefined>>;
}

export interface Runtime {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** The admin client (local unless `AB_ADMIN_URL` is set). */
  client(): Promise<AdminClient>;
  /** The local database and keys (for `keys …`). */
  local(): Promise<Parameters<NonNullable<CommandSpec['local']>>[0]>;
  readonly stdin: () => Promise<string>;
  /** The OS keychain of this machine (P8-08). */
  keychain(): KeychainBackend;
}

export interface CommandSpec {
  readonly words: readonly string[];
  readonly summary: string;
  readonly args?: readonly { name: string; help: string }[];
  readonly options?: readonly OptionSpec[];
  /** Works through the admin API (local or remote). */
  readonly api?: (
    r: Runtime,
    p: Parsed,
  ) => Promise<{ method: string; path: string; body?: unknown; note?: string }>;
  /** Works on the local database only. */
  readonly local?: (
    ctx: {
      storage: import('@agility-bridge/storage-sqlite').SqliteStorage;
      keyring: import('@agility-bridge/auth').Keyring;
    },
    p: Parsed,
    r: Runtime,
  ) => Promise<unknown>;
  /** Needs neither. */
  readonly run?: (r: Runtime, p: Parsed) => Promise<number>;
}

const id = (name: string, help: string) => ({ name, help });
const enc = encodeURIComponent;
const list = (v: unknown) =>
  Array.isArray(v)
    ? v
    : typeof v === 'string'
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
const defined = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** `name` or `service/account` as a keychain entry (P8-08). */
function keychainRef(name: string): KeychainRef {
  try {
    return parseKeychainRef(`keychain:${name}`) as KeychainRef;
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }
}

/** Runs a keychain operation: its failures are refusals with a message, not stack traces. */
function keychainOp<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof KeychainError) throw new ConfigError(error.message);
    throw error;
  }
}

async function agilityToken(r: Runtime, p: Parsed): Promise<string> {
  return readSecret({
    ...(typeof p.opts['from-file'] === 'string' ? { file: p.opts['from-file'] } : {}),
    envName: 'AB_AGILITY_TOKEN',
    env: r.env,
    stdin: r.stdin,
    what: 'Agility access token',
  });
}

const FROM_FILE: OptionSpec = {
  name: 'from-file',
  kind: 'string',
  help: 'Read the Agility token from this 0600 file',
};
const EXPIRES: OptionSpec = {
  name: 'expires-days',
  kind: 'string',
  help: 'Days until it expires, or `never`',
};

function expiresInDays(v: unknown): number | 'never' | undefined {
  if (v === undefined) return undefined;
  if (v === 'never') return 'never';
  const n = Number(v);
  if (!Number.isInteger(n))
    throw new ConfigError('--expires-days must be a whole number of days or "never".');
  return n;
}

function workspaceBody(p: Parsed): Record<string, unknown> {
  const allow = list(p.opts['asset-types-allow']);
  const deny = list(p.opts['asset-types-deny']);
  const limits = p.opts['max-rows'] === undefined ? undefined : { maxRows: p.opts['max-rows'] };
  return defined({
    name: p.opts['name'],
    allowedScopeIds: p.opts['project'],
    includeChildScopes: p.opts['children'] === true ? true : undefined,
    defaultCredentialId: p.opts['default-credential'],
    credentialSource: p.opts['credential-source'],
    enabledTools: list(p.opts['tools']),
    assetTypes: allow === undefined && deny === undefined ? undefined : defined({ allow, deny }),
    limits,
  });
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    words: ['init'],
    summary: 'Write a new master key (0600) to the user configuration directory, never overwriting one',
    options: [
      {
        name: 'key-file',
        kind: 'string',
        help: 'Where to write it (default ~/.config/agility-bridge/master.key)',
      },
      {
        name: 'version',
        kind: 'string',
        help: 'Key version (default 1); a rotation needs one higher than the current key',
      },
      {
        name: 'keychain',
        kind: 'string',
        help: 'Store the new key in the OS keychain under this name instead of a file (never overwrites)',
      },
    ],
    async run(r, p) {
      const version = p.opts['version'] === undefined ? 1 : Number(p.opts['version']);
      if (!Number.isInteger(version) || version < 1 || version > 1_000_000) {
        throw new ConfigError('--version is a whole number ≥ 1.');
      }
      if (typeof p.opts['keychain'] === 'string') {
        const ref = keychainRef(p.opts['keychain']);
        const kc = r.keychain();
        keychainOp(() => {
          if (kc.get(ref.service, ref.account) !== undefined) {
            throw new KeychainError(
              `${kc.label} already has an entry "${ref.service}/${ref.account}"; losing a master key loses every token encrypted with it, so it is not replaced.`,
            );
          }
          kc.set(ref.service, ref.account, generateMasterKey(version));
        });
        const reference = `keychain:${p.opts['keychain']}`;
        r.out(JSON.stringify({ masterKeyReference: reference }));
        r.err(
          `agility-bridge: stored a new master key in the ${kc.label}. Start the server with AB_MASTER_KEY=${reference}, and keep a separate backup of the key (docs/guide/secrets.md): the keychain is not a backup.`,
        );
        return 0;
      }
      const path = createMasterKeyFile(
        typeof p.opts['key-file'] === 'string' ? p.opts['key-file'] : defaultMasterKeyFile(r.env),
        version,
      );
      r.out(JSON.stringify({ masterKeyFile: path }));
      r.err(
        `agility-bridge: wrote a new master key to ${path}. Start the server with AB_MASTER_KEY_FILE=${path}, and back the file up away from the database (docs/guide/secrets.md).`,
      );
      return 0;
    },
  },
  {
    words: ['doctor'],
    summary:
      'Diagnose this setup without changing it: configuration, instance, keys, database and client files (read-only; `--fix` applies only the owner-only file modes it lists)',
    options: [
      {
        name: 'check-token',
        kind: 'flag',
        help: 'Also send one authenticated request to your instance to test the token (never printed)',
      },
      { name: 'offline', kind: 'flag', help: 'Make no network request' },
      { name: 'fix', kind: 'flag', help: 'Apply only the chmod repairs the report lists' },
      { name: 'json', kind: 'flag', help: 'Print the report as JSON' },
    ],
    async run(r, p) {
      const opts = {
        checkToken: p.opts['check-token'] === true,
        offline: p.opts['offline'] === true,
        fix: p.opts['fix'] === true,
      };
      const report = await runDoctor(opts, { env: r.env });
      r.out(p.opts['json'] === true ? JSON.stringify(report, null, 2) : renderReport(report, opts));
      return exitCode(report);
    },
  },
  {
    words: ['keychain', 'set'],
    summary:
      'Store a secret in the OS keychain (from --from-file, AB_KEYCHAIN_SECRET, standard input or a hidden prompt); refer to it as keychain:<name>',
    args: [id('name', 'Entry name, or service/account (service defaults to agility-bridge)')],
    options: [{ name: 'from-file', kind: 'string', help: 'Read the secret from this 0600 file' }],
    async run(r, p) {
      const ref = keychainRef(p.args[0] as string);
      const secret = await readSecret({
        ...(typeof p.opts['from-file'] === 'string' ? { file: p.opts['from-file'] } : {}),
        envName: 'AB_KEYCHAIN_SECRET',
        env: r.env,
        stdin: r.stdin,
        what: 'secret to store',
      });
      const kc = r.keychain();
      keychainOp(() => kc.set(ref.service, ref.account, secret));
      r.out(JSON.stringify({ stored: `keychain:${p.args[0]}` }));
      r.err(
        `agility-bridge: stored in the ${kc.label}. Use keychain:${p.args[0]} where the secret would go (AB_AGILITY_TOKEN, AB_MASTER_KEY).`,
      );
      return 0;
    },
  },
  {
    words: ['keychain', 'delete'],
    summary: 'Remove an entry from the OS keychain',
    args: [id('name', 'Entry name, or service/account')],
    async run(r, p) {
      const ref = keychainRef(p.args[0] as string);
      const deleted = keychainOp(() => r.keychain().delete(ref.service, ref.account));
      r.out(JSON.stringify({ deleted }));
      return 0;
    },
  },
  {
    words: ['keychain', 'status'],
    summary:
      'Show which keychain this machine uses and whether it works; with --name, whether an entry exists (never its value)',
    options: [{ name: 'name', kind: 'string', help: 'Entry name, or service/account' }],
    async run(r, p) {
      const kc = r.keychain();
      const available = keychainOp(() => kc.available());
      let entry: boolean | undefined;
      if (typeof p.opts['name'] === 'string' && available) {
        const ref = keychainRef(p.opts['name']);
        entry = keychainOp(() => kc.get(ref.service, ref.account)) !== undefined;
      }
      r.out(JSON.stringify({ backend: kc.label, available, ...(entry === undefined ? {} : { entry }) }));
      return available ? 0 : 1;
    },
  },
  {
    words: ['admin-token'],
    summary: 'Print a new break-glass admin token for AB_ADMIN_TOKEN_FILE (shown once)',
    async run(r) {
      r.out(generateAdminToken());
      r.err(
        'agility-bridge: a new admin token (shown once). Store it in a 0600 file outside the data directory and set AB_ADMIN_TOKEN_FILE; anyone with it can administer the server.',
      );
      return 0;
    },
  },
  { words: ['user', 'list'], summary: 'List users', api: async () => ({ method: 'GET', path: '/users' }) },
  {
    words: ['user', 'add'],
    summary: 'Add a user',
    args: [id('email', 'Email address')],
    options: [
      { name: 'role', kind: 'string', help: '`member` (default), `admin` or `owner`' },
      { name: 'name', kind: 'string', help: 'Display name' },
    ],
    api: async (_r, p) => ({
      method: 'POST',
      path: '/users',
      body: defined({ email: p.args[0], role: p.opts['role'] ?? 'member', displayName: p.opts['name'] }),
    }),
  },
  {
    words: ['user', 'set-role'],
    summary: "Change a user's role",
    args: [id('user-id', 'User id'), id('role', '`member`, `admin` or `owner`')],
    api: async (_r, p) => ({
      method: 'PATCH',
      path: `/users/${enc(p.args[0] as string)}`,
      body: { role: p.args[1] },
    }),
  },
  {
    words: ['user', 'disable'],
    summary: 'Disable a user',
    args: [id('user-id', 'User id')],
    api: async (_r, p) => ({ method: 'POST', path: `/users/${enc(p.args[0] as string)}/disable` }),
  },
  {
    words: ['user', 'enable'],
    summary: 'Enable a disabled user again (their grants and device tokens that were not revoked work again)',
    args: [id('user-id', 'User id')],
    api: async (_r, p) => ({ method: 'POST', path: `/users/${enc(p.args[0] as string)}/enable` }),
  },
  {
    words: ['user', 'unbind'],
    summary:
      "Clear a user's sign-in identity so they can sign in with another provider (owner; the next verified sign-in with their email binds the account)",
    args: [id('user-id', 'User id')],
    options: [
      {
        name: 'confirm',
        kind: 'string',
        required: true,
        help: "The user's current email address, typed again. Anyone who signs in with that verified email afterwards takes the account",
      },
      {
        name: 'to',
        kind: 'string',
        help: 'Only this provider may bind the account next: one this deployment configured (google, github, cf-access or oidc:<name>), otherwise refused with exit 1 before anything changes; a sign-in at another provider is refused',
      },
      {
        name: 'ttl-minutes',
        kind: 'int',
        help: 'How long --to lasts, in minutes (default 1440, at most 10080)',
      },
    ],
    api: async (_r, p) => ({
      method: 'POST',
      path: `/users/${enc(p.args[0] as string)}/unbind`,
      body: {
        confirm: p.opts['confirm'],
        ...(p.opts['to'] === undefined ? {} : { provider: p.opts['to'] }),
        ...(p.opts['ttl-minutes'] === undefined ? {} : { ttlMinutes: p.opts['ttl-minutes'] }),
      },
    }),
  },
  {
    words: ['user', 'end-sessions'],
    summary: "End all of a user's browser sessions (sign them out everywhere)",
    args: [id('user-id', 'User id')],
    api: async (_r, p) => ({ method: 'POST', path: `/users/${enc(p.args[0] as string)}/sessions/revoke` }),
  },
  {
    words: ['instance', 'list'],
    summary: 'List Agility instances',
    api: async () => ({ method: 'GET', path: '/instances' }),
  },
  {
    words: ['instance', 'add'],
    summary: 'Add an Agility instance',
    args: [
      id('label', 'Name for it'),
      id('url', 'The address you open Agility at, e.g. https://www7.v1host.com/YourInstance'),
    ],
    options: [{ name: 'ca-file', kind: 'string', help: 'PEM bundle of a private CA (Node only)' }],
    api: async (_r, p) => ({
      method: 'POST',
      path: '/instances',
      body: defined({
        label: p.args[0],
        baseUrl: p.args[1],
        tls: p.opts['ca-file'] === undefined ? undefined : { caFile: p.opts['ca-file'] },
      }),
    }),
  },
  {
    words: ['instance', 'retarget'],
    summary: "Change an instance's address or CA (owner; revokes its credentials and grants)",
    args: [id('instance-id', 'Instance id'), id('url', 'The new address')],
    options: [{ name: 'ca-file', kind: 'string', help: 'PEM bundle of a private CA' }],
    api: async (_r, p) => ({
      method: 'POST',
      path: `/instances/${enc(p.args[0] as string)}/retarget`,
      body: defined({
        baseUrl: p.args[1],
        tls: p.opts['ca-file'] === undefined ? undefined : { caFile: p.opts['ca-file'] },
      }),
    }),
  },
  {
    words: ['instance', 'delete'],
    summary: 'Delete an unused instance',
    args: [id('instance-id', 'Instance id')],
    api: async (_r, p) => ({ method: 'DELETE', path: `/instances/${enc(p.args[0] as string)}` }),
  },
  {
    words: ['credential', 'list'],
    summary: 'List credentials (never their tokens)',
    options: [{ name: 'instance', kind: 'string', help: 'Only this instance' }],
    api: async (_r, p) => ({
      method: 'GET',
      path: `/credentials${typeof p.opts['instance'] === 'string' ? `?instanceId=${enc(p.opts['instance'])}` : ''}`,
    }),
  },
  {
    words: ['credential', 'add'],
    summary:
      'Store a shared Agility token (from --from-file, AB_AGILITY_TOKEN, standard input or a hidden prompt)',
    options: [
      { name: 'instance', kind: 'string', help: 'Instance id', required: true },
      { name: 'label', kind: 'string', help: 'Name, e.g. the service member', required: true },
      FROM_FILE,
    ],
    api: async (r, p) => ({
      method: 'POST',
      path: '/credentials',
      body: {
        instanceId: p.opts['instance'],
        ownerUserId: null,
        label: p.opts['label'],
        token: await agilityToken(r, p),
      },
    }),
  },
  {
    words: ['credential', 'replace'],
    summary: "Replace a credential's token (it becomes unvalidated)",
    args: [id('credential-id', 'Credential id')],
    options: [FROM_FILE],
    api: async (r, p) => ({
      method: 'POST',
      path: `/credentials/${enc(p.args[0] as string)}/token`,
      body: { token: await agilityToken(r, p) },
    }),
  },
  {
    words: ['credential', 'validate'],
    summary: 'Ask Agility now whose token it is and what it can reach',
    args: [id('credential-id', 'Credential id')],
    api: async (_r, p) => ({ method: 'POST', path: `/credentials/${enc(p.args[0] as string)}/validate` }),
  },
  {
    words: ['credential', 'revoke'],
    summary: 'Revoke a credential',
    args: [id('credential-id', 'Credential id')],
    api: async (_r, p) => ({ method: 'POST', path: `/credentials/${enc(p.args[0] as string)}/revoke` }),
  },
  {
    words: ['credential', 'delete'],
    summary: 'Delete an unused credential',
    args: [id('credential-id', 'Credential id')],
    api: async (_r, p) => ({ method: 'DELETE', path: `/credentials/${enc(p.args[0] as string)}` }),
  },
  {
    words: ['workspace', 'list'],
    summary: 'List workspaces',
    api: async () => ({ method: 'GET', path: '/workspaces' }),
  },
  {
    words: ['workspace', 'show'],
    summary: 'Show a workspace',
    args: [id('workspace-id', 'Workspace id')],
    api: async (_r, p) => ({ method: 'GET', path: `/workspaces/${enc(p.args[0] as string)}` }),
  },
  {
    words: ['workspace', 'add'],
    summary: 'Create a workspace at /w/<slug>/mcp',
    args: [id('slug', 'URL name: lower-case letters, digits, hyphens')],
    options: [
      { name: 'name', kind: 'string', help: 'Display name', required: true },
      { name: 'instance', kind: 'string', help: 'Instance id', required: true },
      {
        name: 'project',
        kind: 'string',
        repeat: true,
        required: true,
        help: 'Allowed Agility project, Scope:<id> (repeat)',
      },
      { name: 'children', kind: 'flag', help: 'Include sub-projects' },
      { name: 'default-credential', kind: 'string', help: 'Shared credential for grants that name none' },
      { name: 'tools', kind: 'list', help: 'Enabled tools (default: every read tool)' },
      { name: 'asset-types-allow', kind: 'list', help: 'Only these asset types' },
      { name: 'asset-types-deny', kind: 'list', help: 'Never these asset types' },
      { name: 'max-rows', kind: 'int', help: 'Most rows per call' },
      {
        name: 'credential-source',
        kind: 'string',
        help: '`stored` (default) or `passthrough`: callers send their own Agility token (owner; needs AB_PASSTHROUGH=on)',
      },
    ],
    api: async (_r, p) => ({
      method: 'POST',
      path: '/workspaces',
      body: { slug: p.args[0], instanceId: p.opts['instance'], ...workspaceBody(p) },
    }),
  },
  {
    words: ['workspace', 'set'],
    summary: 'Change a workspace (only the options given)',
    args: [id('workspace-id', 'Workspace id')],
    options: [
      { name: 'name', kind: 'string', help: 'Display name' },
      { name: 'project', kind: 'string', repeat: true, help: 'Replace the allowed projects (repeat)' },
      { name: 'default-credential', kind: 'string', help: 'Shared default credential' },
      { name: 'tools', kind: 'list', help: 'Enabled tools' },
      { name: 'max-rows', kind: 'int', help: 'Most rows per call' },
      {
        name: 'credential-source',
        kind: 'string',
        help: '`stored` (default) or `passthrough`: callers send their own Agility token (owner; needs AB_PASSTHROUGH=on)',
      },
    ],
    api: async (_r, p) => ({
      method: 'PATCH',
      path: `/workspaces/${enc(p.args[0] as string)}`,
      body: workspaceBody(p),
    }),
  },
  {
    words: ['workspace', 'disable'],
    summary: 'Disable a workspace',
    args: [id('workspace-id', 'Workspace id')],
    api: async (_r, p) => ({ method: 'POST', path: `/workspaces/${enc(p.args[0] as string)}/disable` }),
  },
  {
    words: ['workspace', 'delete'],
    summary: 'Delete a workspace, its grants and their tokens',
    args: [id('workspace-id', 'Workspace id')],
    api: async (_r, p) => ({ method: 'DELETE', path: `/workspaces/${enc(p.args[0] as string)}` }),
  },
  {
    words: ['grant', 'list'],
    summary: 'List grants',
    options: [{ name: 'workspace', kind: 'string', help: 'Only this workspace' }],
    api: async (_r, p) => ({
      method: 'GET',
      path: `/grants${typeof p.opts['workspace'] === 'string' ? `?workspaceId=${enc(p.opts['workspace'])}` : ''}`,
    }),
  },
  {
    words: ['grant', 'add'],
    summary: 'Grant a user (--user) or a labelled service (--service) access to a workspace',
    options: [
      { name: 'workspace', kind: 'string', help: 'Workspace id', required: true },
      { name: 'user', kind: 'string', help: 'User id' },
      { name: 'service', kind: 'string', help: 'Label of a service grant (read-only)' },
      { name: 'credential', kind: 'string', help: "Credential (default: the workspace's shared default)" },
      { name: 'tools', kind: 'list', help: 'Only these tools' },
      {
        name: 'project',
        kind: 'string',
        repeat: true,
        help: 'Only these of the workspace projects (repeat)',
      },
      EXPIRES,
    ],
    api: async (_r, p) => {
      if ((p.opts['user'] === undefined) === (p.opts['service'] === undefined)) {
        throw new ConfigError('Give exactly one of --user <id> or --service <label>.');
      }
      const days = expiresInDays(p.opts['expires-days']);
      return {
        method: 'POST',
        path: '/grants',
        body: defined({
          workspaceId: p.opts['workspace'],
          userId: p.opts['user'] ?? null,
          label: p.opts['service'],
          credentialId: p.opts['credential'],
          tools: list(p.opts['tools']),
          scopeIds: p.opts['project'],
          expiresAt: days === undefined || days === 'never' ? undefined : Date.now() + days * 86_400_000,
        }),
      };
    },
  },
  {
    words: ['grant', 'revoke'],
    summary: 'Revoke a grant (and so all its tokens)',
    args: [id('grant-id', 'Grant id')],
    api: async (_r, p) => ({ method: 'POST', path: `/grants/${enc(p.args[0] as string)}/revoke` }),
  },
  {
    words: ['grant', 'delete'],
    summary: 'Delete a grant and its tokens',
    args: [id('grant-id', 'Grant id')],
    api: async (_r, p) => ({ method: 'DELETE', path: `/grants/${enc(p.args[0] as string)}` }),
  },
  {
    words: ['token', 'list'],
    summary: "List a grant's device tokens (never the tokens themselves)",
    args: [id('grant-id', 'Grant id')],
    api: async (_r, p) => ({ method: 'GET', path: `/grants/${enc(p.args[0] as string)}/tokens` }),
  },
  {
    words: ['token', 'issue'],
    summary: 'Issue a device token for one device (shown once)',
    args: [id('grant-id', 'Grant id')],
    options: [{ name: 'label', kind: 'string', help: 'The device, e.g. laptop', required: true }, EXPIRES],
    api: async (_r, p) => ({
      method: 'POST',
      path: `/grants/${enc(p.args[0] as string)}/tokens`,
      body: defined({ label: p.opts['label'], expiresInDays: expiresInDays(p.opts['expires-days']) }),
      note: 'The device token is shown once: put it into the MCP client of that device now.',
    }),
  },
  {
    words: ['token', 'revoke'],
    summary: 'Revoke a device token',
    args: [id('token-id', 'Token id')],
    api: async (_r, p) => ({ method: 'POST', path: `/tokens/${enc(p.args[0] as string)}/revoke` }),
  },
  {
    words: ['setup-link'],
    summary:
      'Issue a single-use link that makes whoever signs in with it the first owner (owner; needs AB_PUBLIC_URL and a sign-in provider)',
    options: [
      { name: 'ttl-minutes', kind: 'int', help: 'Minutes until it expires (default 60, at most 10080)' },
    ],
    api: async (_r, p) => ({
      method: 'POST',
      path: '/setup-links',
      body: defined({ ttlMinutes: p.opts['ttl-minutes'] }),
      note: 'Open the url in a browser and sign in. It works once and is shown only now; it makes that sign-in an owner, so share it with no one else.',
    }),
  },
  {
    words: ['audit', 'tail'],
    summary: 'Show the newest audit rows (oldest first)',
    options: [
      { name: 'limit', kind: 'int', help: 'How many (default 20, at most 1000)' },
      { name: 'kind', kind: 'string', help: '`tool_call`, `auth`, `admin` or `write`' },
      { name: 'workspace', kind: 'string', help: 'Only this workspace id' },
    ],
    api: async (_r, p) => {
      const q = new URLSearchParams(
        defined({
          limit: String(p.opts['limit'] ?? 20),
          kind: p.opts['kind'],
          workspaceId: p.opts['workspace'],
        }) as Record<string, string>,
      );
      return { method: 'GET', path: `/audit?${q}` };
    },
  },
  {
    words: ['backup'],
    summary: 'Write a consistent copy of the database to a new 0600 file while the server runs (local)',
    args: [id('file', 'The new backup file (never overwritten)')],
    local: async ({ storage }, p) => {
      await storage.backup(p.args[0] as string);
      return { backup: p.args[0] };
    },
  },
  {
    words: ['restore'],
    summary: 'Check a backup and copy it to a new database file (stop the server first)',
    args: [
      id('backup', 'A file written by `backup`'),
      id('target', 'The new database file (never overwritten)'),
    ],
    async run(r, p) {
      await restoreSqliteBackup(p.args[0] as string, p.args[1] as string);
      r.out(JSON.stringify({ restored: p.args[1] }));
      r.err(
        'agility-bridge: restored. Point AB_DB_PATH at the new file and start the server; it migrates on start.',
      );
      return 0;
    },
  },
  {
    words: ['keys', 'status'],
    summary: 'Credentials per master-key version (owner)',
    api: async () => ({ method: 'GET', path: '/keys' }),
  },
  {
    words: ['keys', 'rotate'],
    summary: 'Re-encrypt stored tokens with the current master key; resumable (local)',
    options: [{ name: 'reason', kind: 'string', help: 'Why, for the audit log', required: true }],
    local: async ({ storage, keyring }, p) =>
      rotateCredentialKeys(storage, keyring, { reason: String(p.opts['reason']), actor: { via: 'cli' } }),
  },
  {
    words: ['keys', 'retire'],
    summary: 'Retire a master-key version no credential uses any more (owner)',
    args: [id('version', 'Key version, e.g. 1')],
    options: [{ name: 'reason', kind: 'string', help: 'Why, for the audit log', required: true }],
    api: async (_r, p) => {
      const version = Number(p.args[0]);
      if (!Number.isInteger(version) || version < 1)
        throw new ConfigError('The version is a whole number ≥ 1.');
      return {
        method: 'POST',
        path: `/keys/${version}/retire`,
        body: { reason: String(p.opts['reason']) },
      };
    },
  },
];

export class UsageError extends Error {
  override name = 'UsageError';
}

export function findCommand(args: readonly string[]): { spec: CommandSpec; rest: string[] } | undefined {
  for (const spec of COMMANDS) {
    if (spec.words.every((w, i) => args[i] === w)) return { spec, rest: args.slice(spec.words.length) };
  }
  return undefined;
}

export function usage(spec: CommandSpec): string {
  const args = (spec.args ?? []).map((a) => `<${a.name}>`).join(' ');
  const opts = (spec.options ?? [])
    .map((o) => {
      const v = o.kind === 'flag' ? '' : o.kind === 'list' ? ' a,b' : o.kind === 'int' ? ' <n>' : ' <value>';
      const one = `--${o.name}${v}`;
      return o.required ? one : `[${one}]`;
    })
    .join(' ');
  return `agility-bridge ${spec.words.join(' ')}${args ? ` ${args}` : ''}${opts ? ` ${opts}` : ''}`;
}

export function parse(spec: CommandSpec, rest: readonly string[]): Parsed {
  const args: string[] = [];
  const opts: Record<string, string | number | boolean | string[]> = {};
  const known = new Map((spec.options ?? []).map((o) => [o.name, o]));
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (!a.startsWith('--')) {
      args.push(a);
      continue;
    }
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const o = known.get(name);
    if (o === undefined) throw new UsageError(`Unknown option --${name.slice(0, 40)}.`);
    if (o.kind === 'flag') {
      opts[name] = true;
      continue;
    }
    const value = inline ?? rest[++i];
    if (value === undefined) throw new UsageError(`--${name} needs a value.`);
    if (o.kind === 'int') {
      const n = Number(value);
      if (!Number.isInteger(n)) throw new UsageError(`--${name} must be a whole number.`);
      opts[name] = n;
    } else if (o.repeat) {
      opts[name] = [...((opts[name] as string[] | undefined) ?? []), value];
    } else {
      opts[name] = value;
    }
  }
  const expected = (spec.args ?? []).length;
  if (args.length !== expected) {
    throw new UsageError(`Expected ${expected} argument${expected === 1 ? '' : 's'}.`);
  }
  for (const o of spec.options ?? []) {
    if (o.required && opts[o.name] === undefined) throw new UsageError(`--${o.name} is required.`);
  }
  return { args, opts };
}

/** Runs one management command; returns the exit code. */
export async function runCommand(spec: CommandSpec, parsed: Parsed, r: Runtime): Promise<number> {
  if (spec.run !== undefined) return spec.run(r, parsed);
  if (spec.local !== undefined) {
    if (r.env['AB_ADMIN_URL'])
      throw new ConfigError(`${spec.words.join(' ')} works on the local database only; unset AB_ADMIN_URL.`);
    const ctx = await r.local();
    try {
      r.out(JSON.stringify(await spec.local(ctx, parsed, r), null, 2));
      return 0;
    } finally {
      await ctx.storage.close();
    }
  }
  const call = await (spec.api as NonNullable<CommandSpec['api']>)(r, parsed);
  const client = await r.client();
  try {
    const res = await client.request(call.method, call.path, call.body);
    if (res.status >= 400) {
      const e = (res.body as { error?: { code?: string; message?: string; field?: string } } | null)?.error;
      r.err(
        `agility-bridge: ${e?.code ?? `HTTP ${res.status}`}: ${e?.message ?? 'request failed'}${e?.field ? ` (${e.field})` : ''}`,
      );
      return 1;
    }
    const body = spec.words[0] === 'audit' && Array.isArray(res.body) ? [...res.body].reverse() : res.body;
    r.out(JSON.stringify(body, null, 2));
    if (call.note !== undefined) r.err(`agility-bridge: ${call.note}`);
    return 0;
  } finally {
    await client.close();
  }
}
