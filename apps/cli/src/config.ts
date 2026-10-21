// SPDX-License-Identifier: Apache-2.0
// stdio configuration (P1-11, L-136): one surface, `AB_` environment variables or a YAML file (`AB_CONFIG`), validated
// at startup with unknown keys rejected. Secrets come from the environment the MCP client sets, or from `${ENV}` and
// `${keychain:service/account}` references in YAML; never from flags (L-026, T23).
import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { canonicalInstanceUrl, type LogLevel, Secret } from '@agility-bridge/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export interface StdioConfig {
  readonly kind: 'configured';
  readonly source: 'environment' | 'yaml';
  readonly workspace: { readonly id: string; readonly name: string };
  readonly instanceUrl: string;
  readonly token: Secret;
  readonly caFile?: string;
  readonly projects: readonly string[];
  readonly includeChildProjects: boolean;
  /** Tool allowlist; undefined means every read tool of the enabled groups. */
  readonly tools?: readonly string[];
  readonly assetTypes: { readonly allow?: readonly string[]; readonly deny: readonly string[] };
  readonly genericQuery: boolean;
  readonly memberEmails: boolean;
  readonly maxRows: number;
  readonly maxResponseBytes: number;
  readonly callBudget: number;
  readonly logLevel: LogLevel;
}

/** No configuration at all: tools are listed and every call answers with setup guidance. */
export interface SetupConfig {
  readonly kind: 'setup';
  readonly logLevel: LogLevel;
}

export type LoadedConfig = StdioConfig | SetupConfig;

/** Every `AB_` name the project knows (ARCHITECTURE §7.1); anything else with the prefix is refused as a typo. */
const KNOWN_ENV = new Set([
  'AB_AGILITY_URL',
  'AB_AGILITY_TOKEN',
  'AB_CONFIG',
  'AB_WORKSPACE',
  'AB_PROJECTS',
  'AB_INCLUDE_CHILD_PROJECTS',
  'AB_TOOLS',
  'AB_ASSET_TYPES_ALLOW',
  'AB_ASSET_TYPES_DENY',
  'AB_GENERIC_QUERY',
  'AB_MEMBER_EMAILS',
  'AB_ATTACHMENT_DOWNLOAD',
  'AB_ATTACHMENT_MAX_BYTES',
  'AB_ATTACHMENT_TYPES',
  'AB_LIMITS_MAX_LIMIT',
  'AB_LIMITS_MAX_RESPONSE_BYTES',
  'AB_CALL_BUDGET',
  'AB_CA_FILE',
  'AB_WRITE_TOOLS',
  'AB_WRITE_APPROVAL',
  'AB_LOG_LEVEL',
  // Remote and Worker settings: valid names, not used by stdio.
  'AB_DATA_DIR',
  'AB_DB_PATH',
  'AB_MASTER_KEY',
  'AB_MASTER_KEY_FILE',
  'AB_MASTER_KEY_PREVIOUS',
  'AB_MASTER_KEY_FILE_PREVIOUS',
  'AB_PUBLIC_URL',
  'AB_ALLOWED_HOSTS',
  'AB_ALLOWED_ORIGINS',
  'AB_TRUSTED_PROXY_HOPS',
  'AB_ACCESS_CACHE_TTL',
  'AB_ADMIN_TOKEN',
  'AB_ADMIN_TOKEN_FILE',
  'AB_AUDIT_RETENTION_DAYS',
  'AB_PASSTHROUGH',
  'AB_OAUTH',
  'AB_PLAN',
]);
const KNOWN_PREFIXES = ['AB_RATE_LIMIT_', 'AB_LIVE_'];
const ENV_MODE_ONLY = [
  'AB_AGILITY_URL',
  'AB_AGILITY_TOKEN',
  'AB_PROJECTS',
  'AB_INCLUDE_CHILD_PROJECTS',
  'AB_TOOLS',
  'AB_ASSET_TYPES_ALLOW',
  'AB_ASSET_TYPES_DENY',
  'AB_GENERIC_QUERY',
  'AB_MEMBER_EMAILS',
  'AB_LIMITS_MAX_LIMIT',
  'AB_LIMITS_MAX_RESPONSE_BYTES',
  'AB_CALL_BUDGET',
];

export const DEFAULTS = Object.freeze({
  maxRows: 100,
  /** Node default (ADR-0010); Workers Free uses 512 KiB. */
  maxResponseBytes: 8 * 1024 * 1024,
  callBudget: 1_000,
});
const MAX_YAML_BYTES = 1024 * 1024;
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const SCOPE_OID = /^Scope:\d{1,12}$/;
const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const TOOL_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

function bool(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  const v = value.trim().toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(v)) return true;
  if (['off', 'false', '0', 'no'].includes(v)) return false;
  throw new ConfigError(`${name} must be on or off (got "${value.slice(0, 20)}").`);
}

function int(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new ConfigError(`${name} must be an integer from ${min} to ${max}.`);
  return n;
}

function list(name: string, value: string | undefined, pattern: RegExp, what: string): string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  for (const item of items) {
    if (!pattern.test(item)) throw new ConfigError(`${name} has an invalid ${what}: "${item.slice(0, 40)}".`);
  }
  return items;
}

function level(value: string | undefined): LogLevel {
  if (value === undefined || value === '') return 'info';
  if (!(LOG_LEVELS as readonly string[]).includes(value))
    throw new ConfigError(`AB_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}.`);
  return value as LogLevel;
}

function instanceUrl(value: string, where: string): string {
  try {
    return canonicalInstanceUrl(value);
  } catch (error) {
    throw new ConfigError(`${where}: ${(error as Error).message}`);
  }
}

/** Refuses `AB_` names that are not ours (usually a typo), listing the closest one. */
export function checkEnvNames(env: Readonly<Record<string, string | undefined>>): void {
  const unknown = Object.keys(env).filter(
    (k) => k.startsWith('AB_') && !KNOWN_ENV.has(k) && !KNOWN_PREFIXES.some((p) => k.startsWith(p)),
  );
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown setting${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}. See docs/guide/configuration.md for the valid AB_ names.`,
    );
  }
}

export type KeychainReader = (service: string, account: string) => string;

/** The OS keychain: macOS `security`, Linux `secret-tool` (libsecret). Never through a shell. */
export const osKeychain: KeychainReader = (service, account) => {
  const opts = {
    encoding: 'utf8' as const,
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
  };
  try {
    if (process.platform === 'darwin')
      return execFileSync(
        'security',
        ['find-generic-password', '-s', service, '-a', account, '-w'],
        opts,
      ).trimEnd();
    if (process.platform === 'linux')
      return execFileSync('secret-tool', ['lookup', 'service', service, 'account', account], opts).trimEnd();
  } catch {
    throw new ConfigError(`The keychain has no entry for service "${service}", account "${account}".`);
  }
  throw new ConfigError(
    `Keychain references are supported on macOS and Linux; on this system use \${ENV} references.`,
  );
};

const REF = /\$\{([^}]{1,200})\}/g;

/** Replaces `${NAME}` and `${keychain:service/account}` in one string value. */
function substitute(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  keychain: KeychainReader,
  path: string,
): string {
  return value.replace(REF, (_m, ref: string) => {
    const k = /^keychain:([^/]{1,100})\/(.{1,100})$/.exec(ref);
    if (k !== null) return keychain(k[1] as string, k[2] as string);
    if (!/^[A-Z_][A-Z0-9_]{0,99}$/.test(ref))
      throw new ConfigError(`${path}: "\${${ref}}" is not an environment variable or keychain reference.`);
    const v = env[ref];
    if (v === undefined || v === '')
      throw new ConfigError(`${path}: environment variable ${ref} is not set.`);
    return v;
  });
}

function substituteAll(
  node: unknown,
  env: Readonly<Record<string, string | undefined>>,
  keychain: KeychainReader,
  path = '$',
): unknown {
  if (typeof node === 'string') return substitute(node, env, keychain, path);
  if (Array.isArray(node)) return node.map((v, i) => substituteAll(v, env, keychain, `${path}[${i}]`));
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, substituteAll(v, env, keychain, `${path}.${k}`)]),
    );
  }
  return node;
}

const workspaceSchema = z.strictObject({
  name: z.string().min(1).max(100).optional(),
  instance: z.strictObject({
    url: z.string().min(1).max(500),
    token: z.string().min(1).max(4_000),
    ca_file: z.string().min(1).max(1_000).optional(),
  }),
  projects: z.array(z.string().regex(SCOPE_OID)).max(500).optional(),
  include_child_projects: z.boolean().optional(),
  tools: z.array(z.string().regex(TOOL_NAME)).max(100).optional(),
  asset_types: z
    .strictObject({
      allow: z.array(z.string().regex(TYPE_NAME)).max(200).optional(),
      deny: z.array(z.string().regex(TYPE_NAME)).max(200).optional(),
    })
    .optional(),
  generic_query: z.boolean().optional(),
  member_emails: z.boolean().optional(),
  limits: z
    .strictObject({
      max_limit: z.number().int().min(1).max(1_000).optional(),
      max_response_bytes: z
        .number()
        .int()
        .min(65_536)
        .max(64 * 1024 * 1024)
        .optional(),
      call_budget: z.number().int().min(1).max(10_000).optional(),
    })
    .optional(),
});

const fileSchema = z.strictObject({
  version: z.literal(1),
  log_level: z.enum(LOG_LEVELS).optional(),
  workspaces: z
    .record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), workspaceSchema)
    .refine((w) => Object.keys(w).length > 0, 'at least one workspace'),
});

export interface FileAccess {
  /** Returns the file's text and whether group or others can read it; undefined when it does not exist. */
  read(path: string): { text: string; bytes: number; groupOrWorldReadable: boolean } | undefined;
}

export const nodeFiles: FileAccess = {
  read(path) {
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new ConfigError(
        `AB_CONFIG ${path} cannot be read: ${(error as NodeJS.ErrnoException).code ?? 'error'}.`,
      );
    }
    try {
      // One file descriptor for the checks and the read (no swap in between).
      const st = fstatSync(fd);
      if (st.size > MAX_YAML_BYTES) return { text: '', bytes: st.size, groupOrWorldReadable: false };
      return {
        text: readFileSync(fd, 'utf8'),
        bytes: st.size,
        groupOrWorldReadable: process.platform !== 'win32' && (st.mode & 0o077) !== 0,
      };
    } finally {
      closeSync(fd);
    }
  },
};

export interface LoadOptions {
  readonly files?: FileAccess;
  readonly keychain?: KeychainReader;
  readonly warn?: (message: string) => void;
}

function fromYaml(env: Readonly<Record<string, string | undefined>>, options: LoadOptions): StdioConfig {
  const path = env['AB_CONFIG'] as string;
  const conflicting = ENV_MODE_ONLY.filter((k) => env[k] !== undefined);
  if (conflicting.length > 0) {
    throw new ConfigError(
      `AB_CONFIG is set, so ${conflicting.join(', ')} must not be: put those settings in the YAML file.`,
    );
  }
  const file = (options.files ?? nodeFiles).read(path);
  if (file === undefined) throw new ConfigError(`AB_CONFIG file ${path} does not exist.`);
  if (file.bytes > MAX_YAML_BYTES) throw new ConfigError(`AB_CONFIG file ${path} is larger than 1 MiB.`);
  if (file.groupOrWorldReadable)
    options.warn?.(`AB_CONFIG file ${path} is readable by other users; run chmod 600 on it.`);
  let raw: unknown;
  try {
    // Plain YAML only: core schema, a small alias budget (no billion laughs), no custom tags.
    raw = parseYaml(file.text, { schema: 'core', maxAliasCount: 50, prettyErrors: false, uniqueKeys: true });
  } catch (error) {
    throw new ConfigError(
      `AB_CONFIG file ${path} is not valid YAML: ${(error as Error).message.split('\n')[0]}`,
    );
  }
  const shape = fileSchema.safeParse(raw);
  if (!shape.success) {
    const issue = shape.error.issues[0];
    throw new ConfigError(
      `AB_CONFIG file ${path}: ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}.`,
    );
  }
  const names = Object.keys(shape.data.workspaces);
  const id = env['AB_WORKSPACE'] ?? (names.length === 1 ? names[0] : undefined);
  if (id === undefined)
    throw new ConfigError(
      `AB_CONFIG has several workspaces (${names.join(', ')}): set AB_WORKSPACE to one of them.`,
    );
  const ws = shape.data.workspaces[id];
  if (ws === undefined)
    throw new ConfigError(`AB_WORKSPACE "${id}" is not in AB_CONFIG (workspaces: ${names.join(', ')}).`);
  // Secrets and paths are substituted only now, and only in the chosen workspace.
  const resolved = workspaceSchema.parse(
    substituteAll(ws, env, options.keychain ?? osKeychain, `workspaces.${id}`),
  );
  return {
    kind: 'configured',
    source: 'yaml',
    workspace: { id, name: resolved.name ?? id },
    instanceUrl: instanceUrl(resolved.instance.url, `workspaces.${id}.instance.url`),
    token: new Secret(resolved.instance.token),
    ...(resolved.instance.ca_file === undefined ? {} : { caFile: resolved.instance.ca_file }),
    projects: resolved.projects ?? [],
    includeChildProjects: resolved.include_child_projects ?? true,
    ...(resolved.tools === undefined ? {} : { tools: resolved.tools }),
    assetTypes: {
      ...(resolved.asset_types?.allow === undefined ? {} : { allow: resolved.asset_types.allow }),
      deny: resolved.asset_types?.deny ?? [],
    },
    genericQuery: resolved.generic_query ?? true,
    memberEmails: resolved.member_emails ?? false,
    maxRows: resolved.limits?.max_limit ?? DEFAULTS.maxRows,
    maxResponseBytes: resolved.limits?.max_response_bytes ?? DEFAULTS.maxResponseBytes,
    callBudget: resolved.limits?.call_budget ?? DEFAULTS.callBudget,
    logLevel:
      env['AB_LOG_LEVEL'] !== undefined ? level(env['AB_LOG_LEVEL']) : (shape.data.log_level ?? 'info'),
  };
}

/** The stdio configuration from the environment the MCP client provides (L-026). */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: LoadOptions = {},
): LoadedConfig {
  checkEnvNames(env);
  const logLevel = level(env['AB_LOG_LEVEL']);
  if (env['AB_CONFIG'] !== undefined && env['AB_CONFIG'] !== '') return fromYaml(env, options);
  const url = env['AB_AGILITY_URL'];
  const token = env['AB_AGILITY_TOKEN'];
  if ((url === undefined || url === '') && (token === undefined || token === '')) {
    const others = ENV_MODE_ONLY.filter((k) => env[k] !== undefined);
    if (others.length > 0)
      throw new ConfigError(`${others.join(', ')} set, but AB_AGILITY_URL and AB_AGILITY_TOKEN are missing.`);
    return { kind: 'setup', logLevel };
  }
  if (url === undefined || url === '')
    throw new ConfigError(
      'AB_AGILITY_TOKEN is set but AB_AGILITY_URL is missing (the address you open Agility at).',
    );
  if (token === undefined || token === '') {
    throw new ConfigError(
      'AB_AGILITY_URL is set but AB_AGILITY_TOKEN is missing: create an access token on the Agility Applications page.',
    );
  }
  return {
    kind: 'configured',
    source: 'environment',
    workspace: { id: 'default', name: 'Default' },
    instanceUrl: instanceUrl(url, 'AB_AGILITY_URL'),
    token: new Secret(token),
    ...(env['AB_CA_FILE'] ? { caFile: env['AB_CA_FILE'] } : {}),
    projects: list('AB_PROJECTS', env['AB_PROJECTS'], SCOPE_OID, 'Agility project (use Scope:1234)') ?? [],
    includeChildProjects: bool('AB_INCLUDE_CHILD_PROJECTS', env['AB_INCLUDE_CHILD_PROJECTS'], true),
    ...(list('AB_TOOLS', env['AB_TOOLS'], TOOL_NAME, 'tool name') === undefined
      ? {}
      : { tools: list('AB_TOOLS', env['AB_TOOLS'], TOOL_NAME, 'tool name') as string[] }),
    assetTypes: {
      ...(list('AB_ASSET_TYPES_ALLOW', env['AB_ASSET_TYPES_ALLOW'], TYPE_NAME, 'asset type') === undefined
        ? {}
        : {
            allow: list(
              'AB_ASSET_TYPES_ALLOW',
              env['AB_ASSET_TYPES_ALLOW'],
              TYPE_NAME,
              'asset type',
            ) as string[],
          }),
      deny: list('AB_ASSET_TYPES_DENY', env['AB_ASSET_TYPES_DENY'], TYPE_NAME, 'asset type') ?? [],
    },
    genericQuery: bool('AB_GENERIC_QUERY', env['AB_GENERIC_QUERY'], true),
    memberEmails: bool('AB_MEMBER_EMAILS', env['AB_MEMBER_EMAILS'], false),
    maxRows: int('AB_LIMITS_MAX_LIMIT', env['AB_LIMITS_MAX_LIMIT'], DEFAULTS.maxRows, 1, 1_000),
    maxResponseBytes: int(
      'AB_LIMITS_MAX_RESPONSE_BYTES',
      env['AB_LIMITS_MAX_RESPONSE_BYTES'],
      DEFAULTS.maxResponseBytes,
      65_536,
      64 * 1024 * 1024,
    ),
    callBudget: int('AB_CALL_BUDGET', env['AB_CALL_BUDGET'], DEFAULTS.callBudget, 1, 10_000),
    logLevel,
  };
}
