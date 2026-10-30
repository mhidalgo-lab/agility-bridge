// SPDX-License-Identifier: Apache-2.0
// stdio configuration (P1-11, L-136): one surface, `AB_` environment variables or a YAML file (`AB_CONFIG`), validated
// at startup with unknown keys rejected. Secrets come from the environment the MCP client sets, or from `${ENV}` and
// `${keychain:service/account}` references in YAML; never from flags (L-026, T23).
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { IDENTITY_SECRET_NAMES, IDENTITY_SETTING_NAMES } from '@agility-bridge/auth';
import {
  ACTIVE_ATTACHMENT_TYPES,
  CUSTOM_FIELD_RE,
  canonicalInstanceUrl,
  DEFAULT_ATTACHMENT_TYPES,
  type LogLevel,
  MAX_CUSTOM_FIELDS,
  Secret,
} from '@agility-bridge/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  DEFAULT_SERVICE,
  KeychainError,
  keychainFor,
  parseKeychainRef,
  readKeychainRef,
} from './keychain.ts';

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
  /** `get_attachment` (D-08): off by default. */
  readonly attachmentDownload: boolean;
  /** The composite reports group (P6-07, D-101): off by default. */
  readonly reports: boolean;
  /** MCP Apps views (P8-03): on by default, offered only to a client that declared Apps; `AB_MCP_APPS=off` is the kill switch. */
  readonly mcpApps: boolean;
  /**
   * `AB_WRITE_TOOLS=on` (P7-01, ADR-0013): write tools may be offered, and only the ones `AB_TOOLS` names ("all tools"
   * never includes a write). Off by default.
   */
  readonly writeTools: boolean;
  /** `required` (default): a person approves every write. `off`: stdio only, your own token (D-10); warned at start. */
  readonly writeApproval: 'required' | 'off';
  /** Custom attributes (`Custom_X`) the create and update tools may write (P7-20): `AB_WRITE_CUSTOM_FIELDS`. None by default. */
  readonly writeCustomFields: readonly string[];
  /** Writes an hour for this process (P7-03); the same variable limits a grant on the remote hosts. */
  readonly writeRatePerHour: number;
  readonly attachmentMaxBytes: number;
  readonly attachmentTypes: readonly string[];
  readonly maxRows: number;
  readonly maxResponseBytes: number;
  readonly callBudget: number;
  /** Seconds a repeated read is answered from memory (P8-01); 0 or absent is off. */
  readonly queryCacheTtlSeconds?: number;
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
  'AB_REPORTS',
  'AB_MCP_APPS',
  'AB_ATTACHMENT_MAX_BYTES',
  'AB_ATTACHMENT_TYPES',
  'AB_LIMITS_MAX_LIMIT',
  'AB_LIMITS_MAX_RESPONSE_BYTES',
  'AB_CALL_BUDGET',
  'AB_QUERY_CACHE_TTL',
  'AB_CA_FILE',
  'AB_WRITE_TOOLS',
  'AB_WRITE_APPROVAL',
  'AB_WRITE_CUSTOM_FIELDS',
  'AB_WRITE_RATE_PER_GRANT_HOURLY',
  'AB_LOG_LEVEL',
  // Remote and Worker settings: valid names, not used by stdio.
  'AB_DATA_DIR',
  'AB_HOST',
  'AB_WRITE_RATE_DEPLOYMENT_HOURLY',
  'AB_RATE_LIMIT',
  'AB_RATE_LIMIT_IP_PER_MINUTE',
  'AB_RATE_LIMIT_AUTH_FAILURES',
  'AB_RATE_LIMIT_TOKEN_PER_MINUTE',
  'AB_RATE_LIMIT_GRANT_PER_MINUTE',
  'AB_RATE_LIMIT_VALIDATIONS_PER_MINUTE',
  'AB_RATE_LIMIT_SIGN_IN',
  'AB_SESSION_IDLE_MINUTES',
  'AB_SESSION_MAX_HOURS',
  'AB_SESSION_MAX_PER_USER',
  'AB_LOGOUT_CLEAR_SITE_DATA',
  'AB_PORT',
  'AB_ENVIRONMENT',
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
  'AB_QUERY_CACHE_EDGE',
  'AB_TASKS',
  'AB_QUOTA_DAILY',
  'AB_QUOTA_MONTHLY',
  'AB_ADMIN_TOKEN',
  'AB_ADMIN_URL',
  'AB_ADMIN_TOKEN_FILE',
  // Secrets for management commands (P8-05, P8-08): read from the environment, never from a flag.
  'AB_CONFIG_PASSPHRASE',
  'AB_KEYCHAIN_SECRET',
  'AB_AUDIT_RETENTION_DAYS',
  'AB_CREDENTIAL_REVALIDATION_HOURS',
  'AB_PASSTHROUGH',
  'AB_ALLOW_HTTP_INSTANCES',
  'AB_PUBLIC_TOOL_CATALOG',
  'AB_OTEL_ENDPOINT',
  'AB_OTEL_HEADERS',
  'AB_INSTANCE_PRIVATE_ADDRESSES',
  'AB_OAUTH',
  'AB_OAUTH_ACCESS_TTL',
  'AB_OAUTH_REFRESH_TTL',
  'AB_OAUTH_CIMD',
  'AB_OAUTH_CIMD_MAX_CLIENTS',
  'AB_OAUTH_CIMD_FETCH_LIMIT',
  'AB_OAUTH_DCR',
  'AB_OAUTH_DCR_MAX_CLIENTS',
  'AB_OAUTH_DCR_IP_LIMIT',
  'AB_OAUTH_DCR_REDIRECT_HOSTS',
  'AB_OAUTH_DCR_UNUSED_TTL',
  'AB_OAUTH_DCR_LIMIT',
  'AB_OAUTH_CIMD_LIMIT',
  'AB_OAUTH_AUTHORIZE_IP_LIMIT',
  'AB_OAUTH_AUTHORIZE_LIMIT',
  'AB_OAUTH_CONSENT_IP_LIMIT',
  'AB_OAUTH_CONSENT_LIMIT',
  'AB_OAUTH_TOKEN_FAILURE_IP_LIMIT',
  'AB_OAUTH_TOKEN_FAILURE_LIMIT',
  'AB_OAUTH_REFRESH_REUSE_WINDOW',
  'AB_OAUTH_IDLE_TTL',
  'AB_OAUTH_CIMD_HOSTS',
  'AB_PLAN',
  // Sign-in (P4-01): the provider settings, their secrets as 0600 files, and the IdP address policy.
  ...IDENTITY_SETTING_NAMES,
  ...IDENTITY_SECRET_NAMES.map((n) => `${n}_FILE`),
  'AB_IDENTITY_PRIVATE_ADDRESSES',
]);
const KNOWN_PREFIXES = ['AB_LIVE_'];
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
  'AB_ATTACHMENT_DOWNLOAD',
  'AB_REPORTS',
  'AB_ATTACHMENT_MAX_BYTES',
  'AB_ATTACHMENT_TYPES',
  'AB_LIMITS_MAX_LIMIT',
  'AB_LIMITS_MAX_RESPONSE_BYTES',
  'AB_CALL_BUDGET',
];

export const DEFAULTS = Object.freeze({
  attachmentMaxBytes: 1_048_576,
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
const MEDIA_TYPE_LOOSE = /^[^\s,]{1,130}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

/** `AB_ATTACHMENT_TYPES`: exact `type/subtype` names, lower case; types that run or render are refused (A8). */
function attachmentTypes(name: string, items: readonly string[] | undefined): string[] {
  if (items === undefined) return [...DEFAULT_ATTACHMENT_TYPES];
  const types = items.map((t) => t.trim().toLowerCase());
  for (const t of types) {
    if (!MEDIA_TYPE.test(t))
      throw new ConfigError(`${name} has an invalid content type: "${t.slice(0, 40)}".`);
    if (ACTIVE_ATTACHMENT_TYPES.includes(t))
      throw new ConfigError(`${name}: ${t} runs or renders in a client and is never returned.`);
  }
  return [...new Set(types)];
}

function bool(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  const v = value.trim().toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(v)) return true;
  if (['off', 'false', '0', 'no'].includes(v)) return false;
  throw new ConfigError(`${name} must be on or off (got "${value.slice(0, 20)}").`);
}

function writeApproval(value: string | undefined): 'required' | 'off' {
  if (value === undefined || value === '') return 'required';
  const v = value.trim().toLowerCase();
  if (v === 'required' || v === 'off') return v;
  throw new ConfigError(`AB_WRITE_APPROVAL must be required or off (got "${value.slice(0, 20)}").`);
}

function customFields(value: string | undefined): readonly string[] {
  const items =
    list('AB_WRITE_CUSTOM_FIELDS', value, CUSTOM_FIELD_RE, 'custom attribute (use Custom_Name)') ?? [];
  if (items.length > MAX_CUSTOM_FIELDS) {
    throw new ConfigError(`AB_WRITE_CUSTOM_FIELDS names more than ${MAX_CUSTOM_FIELDS} attributes.`);
  }
  return [...new Set(items)];
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
  if (items.length === 0) return undefined;
  for (const item of items) {
    if (!pattern.test(item)) throw new ConfigError(`${name} has an invalid ${what}: "${item.slice(0, 40)}".`);
  }
  return items;
}

/** `AB_PROJECTS`: unset means every project; set but empty (`" "`, `",,"`) is refused rather than read as "all". */
function projectList(value: string | undefined): string[] {
  if (value === undefined) return [];
  const items = list('AB_PROJECTS', value, SCOPE_OID, 'Agility project (use Scope:1234)');
  if (items === undefined) {
    throw new ConfigError(
      'AB_PROJECTS is set but empty: unset it to allow every project, or list Scope:<id> tokens.',
    );
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

/** Names that only a remote host (`serve`, the Worker) reads: stdio accepts them as valid but does nothing with them. */
const SERVE_ONLY = [
  'AB_QUOTA_DAILY',
  'AB_QUOTA_MONTHLY',
  'AB_OTEL_ENDPOINT',
  'AB_OTEL_HEADERS',
  'AB_TASKS',
  'AB_QUERY_CACHE_EDGE',
  'AB_PUBLIC_TOOL_CATALOG',
] as const;

/** A cost control or a trace export that silently does nothing is the worst kind (Q-7): say so on stderr. */
function warnServeOnly(
  env: Readonly<Record<string, string | undefined>>,
  warn: ((message: string) => void) | undefined,
): void {
  const set = SERVE_ONLY.filter((k) => env[k] !== undefined && env[k] !== '');
  if (set.length > 0 && warn !== undefined)
    warn(
      `${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} read by a remote host only; the stdio server ignores ${set.length === 1 ? 'it' : 'them'} (no quota, trace export or task support is applied here).`,
    );
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

/** The OS keychain (P8-08, L-103): the platform tool, no shell, no fallback; failures are `ConfigError`s. */
export const osKeychain: KeychainReader = (service, account) => {
  try {
    return readKeychainRef({ service, account }, keychainFor(process.platform));
  } catch (error) {
    if (error instanceof KeychainError) throw new ConfigError(error.message);
    throw error;
  }
};

/**
 * A value that is a `keychain:<name>` or `keychain:<service>/<account>` reference becomes the secret it names; any other
 * value is returned as it is. The error names the reference and never a value (P8-08).
 */
export function resolveSecretValue(
  value: string,
  what: string,
  keychain: KeychainReader = osKeychain,
  anyService = false,
): string {
  let ref: ReturnType<typeof parseKeychainRef>;
  try {
    ref = parseKeychainRef(value);
  } catch (error) {
    throw new ConfigError(`${what}: ${(error as Error).message}`);
  }
  if (ref === undefined) return value;
  // A value from a client's env block can come from a project file the user did not write: it reads this tool's own
  // namespace only, never another application's entries (S-2, D-290). The user's own YAML file may name any service.
  if (!anyService && ref.service !== DEFAULT_SERVICE) {
    throw new ConfigError(
      `${what}: an environment value may refer only to entries of the "${DEFAULT_SERVICE}" service (keychain:<name>); a keychain:<service>/<account> reference of another service is allowed in the YAML configuration file only.`,
    );
  }
  const secret = keychain(ref.service, ref.account);
  if (secret === '') throw new ConfigError(`${what}: the keychain entry is empty.`);
  return secret;
}

const REF = /\$\{([^}]{1,200})\}/g;

/** Replaces `${NAME}` and `${keychain:service/account}` in one string value; `$${` stands for a literal `${`. */
function substitute(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  keychain: KeychainReader,
  path: string,
): string {
  const parts = value.split('$${');
  return parts
    .map((part) =>
      part.replace(REF, (_m, ref: string) => {
        if (ref.startsWith('keychain:')) return resolveSecretValue(ref, path, keychain, true);
        if (!/^[A-Z_][A-Z0-9_]{0,99}$/.test(ref))
          throw new ConfigError(
            `${path}: "\${${ref}}" is not an environment variable or keychain reference.`,
          );
        const v = env[ref];
        if (v === undefined || v === '')
          throw new ConfigError(`${path}: environment variable ${ref} is not set.`);
        return v;
      }),
    )
    .join('${');
}

/** True when a string anywhere in `node` holds a reference (an escaped `$${` is not one). */
function hasReference(node: unknown): boolean {
  if (typeof node === 'string') return node.split('$${').some((p) => p.includes('${'));
  if (Array.isArray(node)) return node.some(hasReference);
  if (node !== null && typeof node === 'object') return Object.values(node).some(hasReference);
  return false;
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
  reports: z.boolean().optional(),
  mcp_apps: z.boolean().optional(),
  writes: z
    .strictObject({
      enabled: z.boolean().optional(),
      approval: z.enum(['required', 'off']).optional(),
      custom_fields: z.array(z.string().regex(CUSTOM_FIELD_RE)).max(MAX_CUSTOM_FIELDS).optional(),
    })
    .optional(),
  member_emails: z.boolean().optional(),
  attachments: z
    .strictObject({
      download: z.boolean().optional(),
      max_bytes: z
        .number()
        .int()
        .min(1_024)
        .max(8 * 1024 * 1024)
        .optional(),
      types: z.array(z.string().min(3).max(130)).max(20).optional(),
    })
    .optional(),
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
  // References only in the token (review M3): a file cannot pull other secrets into the URL, a name or a path, where
  // they could reach another host or be shown to the agent. The file still decides where the token goes: trust it.
  const { token: rawToken, ...instanceRest } = ws.instance;
  if (hasReference({ ...ws, instance: instanceRest })) {
    throw new ConfigError(`workspaces.${id}: \${…} references are allowed only in instance.token.`);
  }
  const token = substitute(rawToken, env, options.keychain ?? osKeychain, `workspaces.${id}.instance.token`);
  if (token === '') throw new ConfigError(`workspaces.${id}.instance.token is empty.`);
  const resolved = { ...ws, instance: { ...ws.instance, token } };
  if (resolved.projects !== undefined && resolved.projects.length === 0) {
    throw new ConfigError(
      `workspaces.${id}.projects is empty: omit it to allow every project, or list Scope:<id> tokens.`,
    );
  }
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
    reports: resolved.reports ?? false,
    mcpApps: resolved.mcp_apps ?? true,
    writeTools: resolved.writes?.enabled ?? false,
    writeApproval: resolved.writes?.approval ?? 'required',
    writeCustomFields: resolved.writes?.custom_fields ?? [],
    writeRatePerHour: int(
      'AB_WRITE_RATE_PER_GRANT_HOURLY',
      env['AB_WRITE_RATE_PER_GRANT_HOURLY'],
      20,
      1,
      1_000,
    ),
    attachmentDownload: resolved.attachments?.download ?? false,
    attachmentMaxBytes: resolved.attachments?.max_bytes ?? DEFAULTS.attachmentMaxBytes,
    attachmentTypes: attachmentTypes(`workspaces.${id}.attachments.types`, resolved.attachments?.types),
    maxRows: resolved.limits?.max_limit ?? DEFAULTS.maxRows,
    maxResponseBytes: resolved.limits?.max_response_bytes ?? DEFAULTS.maxResponseBytes,
    callBudget: resolved.limits?.call_budget ?? DEFAULTS.callBudget,
    queryCacheTtlSeconds: int('AB_QUERY_CACHE_TTL', env['AB_QUERY_CACHE_TTL'], 0, 0, 60),
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
  if (env['AB_CONFIG'] !== undefined && env['AB_CONFIG'] !== '') {
    warnServeOnly(env, options.warn);
    return fromYaml(env, options);
  }
  const url = env['AB_AGILITY_URL'];
  const rawToken = env['AB_AGILITY_TOKEN'];
  if ((url === undefined || url === '') && (rawToken === undefined || rawToken === '')) {
    const others = ENV_MODE_ONLY.filter((k) => env[k] !== undefined);
    if (others.length > 0)
      throw new ConfigError(`${others.join(', ')} set, but AB_AGILITY_URL and AB_AGILITY_TOKEN are missing.`);
    return { kind: 'setup', logLevel };
  }
  if (url === undefined || url === '')
    throw new ConfigError(
      'AB_AGILITY_TOKEN is set but AB_AGILITY_URL is missing (the address you open Agility at).',
    );
  if (rawToken === undefined || rawToken === '') {
    throw new ConfigError(
      'AB_AGILITY_URL is set but AB_AGILITY_TOKEN is missing: create an access token on the Agility Applications page.',
    );
  }
  warnServeOnly(env, options.warn);
  // `keychain:<name>` keeps the token out of the client's configuration file (P8-08).
  const token = resolveSecretValue(rawToken, 'AB_AGILITY_TOKEN', options.keychain);
  return {
    kind: 'configured',
    source: 'environment',
    workspace: { id: 'default', name: 'Default' },
    instanceUrl: instanceUrl(url, 'AB_AGILITY_URL'),
    token: new Secret(token),
    ...(env['AB_CA_FILE'] ? { caFile: env['AB_CA_FILE'] } : {}),
    projects: projectList(env['AB_PROJECTS']),
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
    reports: bool('AB_REPORTS', env['AB_REPORTS'], false),
    mcpApps: bool('AB_MCP_APPS', env['AB_MCP_APPS'], true),
    writeTools: bool('AB_WRITE_TOOLS', env['AB_WRITE_TOOLS'], false),
    writeApproval: writeApproval(env['AB_WRITE_APPROVAL']),
    writeCustomFields: customFields(env['AB_WRITE_CUSTOM_FIELDS']),
    writeRatePerHour: int(
      'AB_WRITE_RATE_PER_GRANT_HOURLY',
      env['AB_WRITE_RATE_PER_GRANT_HOURLY'],
      20,
      1,
      1_000,
    ),
    attachmentDownload: bool('AB_ATTACHMENT_DOWNLOAD', env['AB_ATTACHMENT_DOWNLOAD'], false),
    attachmentMaxBytes: int(
      'AB_ATTACHMENT_MAX_BYTES',
      env['AB_ATTACHMENT_MAX_BYTES'],
      DEFAULTS.attachmentMaxBytes,
      1_024,
      8 * 1024 * 1024,
    ),
    attachmentTypes: attachmentTypes(
      'AB_ATTACHMENT_TYPES',
      list('AB_ATTACHMENT_TYPES', env['AB_ATTACHMENT_TYPES'], MEDIA_TYPE_LOOSE, 'content type'),
    ),
    maxRows: int('AB_LIMITS_MAX_LIMIT', env['AB_LIMITS_MAX_LIMIT'], DEFAULTS.maxRows, 1, 1_000),
    maxResponseBytes: int(
      'AB_LIMITS_MAX_RESPONSE_BYTES',
      env['AB_LIMITS_MAX_RESPONSE_BYTES'],
      DEFAULTS.maxResponseBytes,
      65_536,
      64 * 1024 * 1024,
    ),
    callBudget: int('AB_CALL_BUDGET', env['AB_CALL_BUDGET'], DEFAULTS.callBudget, 1, 10_000),
    queryCacheTtlSeconds: int('AB_QUERY_CACHE_TTL', env['AB_QUERY_CACHE_TTL'], 0, 0, 60),
    logLevel,
  };
}
