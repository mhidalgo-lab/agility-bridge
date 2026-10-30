// SPDX-License-Identifier: Apache-2.0
// What `agility-bridge serve` (Node) and the Cloudflare Worker share (P3-01): the `AB_*` settings with the same checks,
// and the app assembled from storage, keyring and host services. Node-only settings (paths, host, port, proxy hops, CA
// bundles) stay in the CLI; Workers-only ones (bindings, plan presets) in the Worker.
import {
  type AccessServices,
  type AdminTokenVerifier,
  accessServices,
  createIdentityProviders,
  credentialValidator,
  type DeploymentLimits,
  IDENTITY_SETTING_NAMES,
  IdentityConfigError,
  type IdentitySettings,
  identitySettingsFromEnv,
  KeyPurpose,
  type Keyring,
  type SessionTimeouts,
} from '@agility-bridge/auth';
import {
  CORE_TOOLS,
  DEFAULT_LIMITS,
  DEFAULT_WRITE_RATE_LIMITS,
  type FetchLike,
  type Logger,
  type LogLevel,
  MAX_QUERY_CACHE_TTL_SECONDS,
  QueryCache,
  type SharedTier,
  type ToolRegistry,
} from '@agility-bridge/core';
import type { Storage } from '@agility-bridge/storage';
import type { Context } from 'hono';
import { adminTokenAuthenticator } from './admin/api.ts';
import { createHttpApp, type HostServices, type HttpApp } from './app.ts';
import { type AdminChange, AuditWriter } from './audit.ts';
import type { ClientMetadataFetch } from './oauth/clients.ts';
import type { OAuthConsentHandler } from './oauth/server.ts';
import {
  OAUTH_SETTING_NAMES,
  OAuthConfigError,
  type OAuthSettings,
  oauthSettingsFromEnv,
} from './oauth/settings.ts';
import {
  createRequestLimits,
  DEFAULT_RATE_LIMITS,
  type RateLimitConfig,
  type RateLimiter,
} from './rate-limit.ts';
import type { SessionOptions } from './session.ts';
import { createHttpWrites } from './writes.ts';

/** A setting is missing or malformed; the message names the setting, never its value. */
export class SettingsError extends Error {
  override name = 'SettingsError';
}

type Env = Readonly<Record<string, string | undefined>>;

/** The settings both hosts read (docs/guide/configuration.md). */
export const SERVER_SETTING_NAMES: readonly string[] = Object.freeze([
  'AB_LOG_LEVEL',
  'AB_ENVIRONMENT',
  'AB_PUBLIC_URL',
  'AB_ALLOWED_HOSTS',
  'AB_ALLOWED_ORIGINS',
  'AB_ACCESS_CACHE_TTL',
  'AB_CALL_BUDGET',
  'AB_LIMITS_MAX_RESPONSE_BYTES',
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
  'AB_AUDIT_RETENTION_DAYS',
  'AB_CREDENTIAL_REVALIDATION_HOURS',
  'AB_PASSTHROUGH',
  'AB_WRITE_TOOLS',
  'AB_WRITE_RATE_PER_GRANT_HOURLY',
  'AB_WRITE_RATE_DEPLOYMENT_HOURLY',
  'AB_ALLOW_HTTP_INSTANCES',
  'AB_PUBLIC_TOOL_CATALOG',
  'AB_QUERY_CACHE_TTL',
  'AB_QUERY_CACHE_EDGE',
  ...IDENTITY_SETTING_NAMES,
  ...OAUTH_SETTING_NAMES,
]);

/**
 * What the host brings that some settings need. `oauthConsent`: the host injects its own consent step (tests). Without
 * one, `AB_OAUTH=on` uses the built-in consent screen (P5-04), which needs sign-in: people approve apps with a session.
 */
export interface HostFeatures {
  readonly oauthConsent?: boolean;
}

export interface ServerSettings {
  readonly publicUrl?: string;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly accessCacheTtlSeconds: number;
  readonly environment: 'live' | 'test';
  readonly callBudget: number;
  readonly maxResponseBytes: number;
  readonly logLevel: LogLevel;
  readonly rateLimits: RateLimitConfig;
  /** Days audit rows are kept (default 90; 0 keeps them forever). */
  readonly auditRetentionDays: number;
  /** Hours between credential revalidations (default 24; 0 = never). */
  readonly revalidationHours: number;
  /** `AB_PASSTHROUGH=on`: pass-through workspaces accept the caller's own Agility token (P2-14, off by default). */
  readonly passthrough: boolean;
  /** `AB_ALLOW_HTTP_INSTANCES=on`: plain-HTTP loopback instance URLs, for tests and local fixtures (P2-19). */
  readonly allowHttpInstances: boolean;
  /** `AB_PUBLIC_TOOL_CATALOG=on` (P8-11, T33): the static read-only catalogue is listed without a credential. Off by default. */
  readonly publicToolCatalog: boolean;
  /** `AB_WRITE_TOOLS=on` (P7-01, ADR-0013): write tools may be offered; every other layer still has to enable them. */
  readonly writeTools: boolean;
  /** Writes an hour per grant and per deployment (P7-03, D-169); the counters are shared in `kv`, so they hold across isolates. */
  readonly writeRates: { readonly perGrant: number; readonly deployment: number };
  /**
   * The query cache (P8-01): `ttlSeconds` 0 is off (default); `edge` adds the encrypted shared tier where the host has
   * one (Workers Cache API, `AB_QUERY_CACHE_EDGE=on`).
   */
  readonly queryCache: { readonly ttlSeconds: number; readonly edge: boolean };
  /** Sign-in providers and the login policy (P4-01); absent = no `/auth` routes. */
  readonly identity?: IdentitySettings;
  /** Admin session timeouts, cap and logout behaviour (P4-02); only used with sign-in. */
  readonly session: SessionOptions;
  /** `AB_OAUTH=on` (P5-01): the OAuth 2.1 authorization server; absent = device tokens only. */
  readonly oauth?: OAuthSettings;
}

/** Host defaults: ADR-0010 presets (Node 1,000 requests and 8 MiB; Workers Free 45 and 512 KiB). */
export interface SettingDefaults {
  readonly callBudget: number;
  readonly maxResponseBytes: number;
  /**
   * The deployment-wide writes an hour used when `AB_WRITE_RATE_DEPLOYMENT_HOURLY` is not set, and the most the host
   * allows when it has a ceiling (Workers Free, P7-30). Absent: the server's own default.
   */
  readonly writeDeploymentRate?: number;
}

export function settingList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export function settingInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new SettingsError(`${name} must be an integer from ${min} to ${max}.`);
  return n;
}

function onOff(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new SettingsError(`${name} must be on or off.`);
}

/** Parses and checks the shared settings. Throws `SettingsError` naming the first bad one. */
export function parseServerSettings(
  env: Env,
  defaults: SettingDefaults,
  features: HostFeatures = {},
): ServerSettings {
  const level = env['AB_LOG_LEVEL'] ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(level))
    throw new SettingsError('AB_LOG_LEVEL must be debug, info, warn or error.');
  const environment = env['AB_ENVIRONMENT'] ?? 'production';
  if (environment !== 'production' && environment !== 'test') {
    throw new SettingsError(
      'AB_ENVIRONMENT must be production (device tokens ab_live_…) or test (ab_test_…).',
    );
  }
  let publicUrl: string | undefined;
  if (env['AB_PUBLIC_URL'] !== undefined && env['AB_PUBLIC_URL'] !== '') {
    try {
      const u = new URL(env['AB_PUBLIC_URL']);
      if (
        (u.protocol !== 'https:' && u.protocol !== 'http:') ||
        u.username !== '' ||
        u.search !== '' ||
        u.hash !== ''
      ) {
        throw new Error('bad');
      }
      publicUrl = u.origin;
    } catch {
      throw new SettingsError('AB_PUBLIC_URL must be the public origin, e.g. https://mcp.example.com.');
    }
  }
  for (const o of settingList(env['AB_ALLOWED_ORIGINS'])) {
    if (o === 'null' || !/^https?:\/\/[^/\s]+$/.test(o)) {
      throw new SettingsError(`AB_ALLOWED_ORIGINS has an invalid origin: "${o.slice(0, 60)}".`);
    }
  }
  const int = settingInteger;
  let oauth: OAuthSettings | null;
  try {
    oauth = oauthSettingsFromEnv(env, publicUrl !== undefined);
  } catch (error) {
    // The message names the variable, never its value.
    if (error instanceof OAuthConfigError) throw new SettingsError(error.message);
    throw error;
  }
  let identity: IdentitySettings | null;
  try {
    identity = identitySettingsFromEnv(env);
  } catch (error) {
    // The message names the variable, never its value.
    if (error instanceof IdentityConfigError) throw new SettingsError(error.message);
    throw error;
  }
  // The consent screen signs people in to approve an app: without a sign-in provider there is nobody to approve.
  if (oauth !== null && identity === null && features.oauthConsent !== true) {
    throw new SettingsError(
      'AB_OAUTH=on needs sign-in (an identity provider: AB_GOOGLE_*, AB_GITHUB_*, AB_OIDC_*): people approve apps on a consent screen after signing in.',
    );
  }
  return {
    ...(publicUrl === undefined ? {} : { publicUrl }),
    allowedHosts: settingList(env['AB_ALLOWED_HOSTS']),
    allowedOrigins: settingList(env['AB_ALLOWED_ORIGINS']),
    accessCacheTtlSeconds: int('AB_ACCESS_CACHE_TTL', env['AB_ACCESS_CACHE_TTL'], 30, 0, 60),
    environment: environment === 'production' ? 'live' : 'test',
    callBudget: int('AB_CALL_BUDGET', env['AB_CALL_BUDGET'], defaults.callBudget, 1, 10_000),
    maxResponseBytes: int(
      'AB_LIMITS_MAX_RESPONSE_BYTES',
      env['AB_LIMITS_MAX_RESPONSE_BYTES'],
      defaults.maxResponseBytes,
      65_536,
      64 * 1024 * 1024,
    ),
    logLevel: level as LogLevel,
    rateLimits: {
      enabled: onOff('AB_RATE_LIMIT', env['AB_RATE_LIMIT'], true),
      ipPerMinute: int(
        'AB_RATE_LIMIT_IP_PER_MINUTE',
        env['AB_RATE_LIMIT_IP_PER_MINUTE'],
        DEFAULT_RATE_LIMITS.ipPerMinute,
        1,
        1_000_000,
      ),
      authFailuresPer5Minutes: int(
        'AB_RATE_LIMIT_AUTH_FAILURES',
        env['AB_RATE_LIMIT_AUTH_FAILURES'],
        DEFAULT_RATE_LIMITS.authFailuresPer5Minutes,
        1,
        10_000,
      ),
      tokenPerMinute: int(
        'AB_RATE_LIMIT_TOKEN_PER_MINUTE',
        env['AB_RATE_LIMIT_TOKEN_PER_MINUTE'],
        DEFAULT_RATE_LIMITS.tokenPerMinute,
        1,
        100_000,
      ),
      grantPerMinute: int(
        'AB_RATE_LIMIT_GRANT_PER_MINUTE',
        env['AB_RATE_LIMIT_GRANT_PER_MINUTE'],
        DEFAULT_RATE_LIMITS.grantPerMinute,
        1,
        100_000,
      ),
      validationsPerMinute: int(
        'AB_RATE_LIMIT_VALIDATIONS_PER_MINUTE',
        env['AB_RATE_LIMIT_VALIDATIONS_PER_MINUTE'],
        DEFAULT_RATE_LIMITS.validationsPerMinute,
        1,
        10_000,
      ),
      signInPer5Minutes: int(
        'AB_RATE_LIMIT_SIGN_IN',
        env['AB_RATE_LIMIT_SIGN_IN'],
        DEFAULT_RATE_LIMITS.signInPer5Minutes,
        1,
        100_000,
      ),
    },
    auditRetentionDays: int('AB_AUDIT_RETENTION_DAYS', env['AB_AUDIT_RETENTION_DAYS'], 90, 0, 36_500),
    revalidationHours: int(
      'AB_CREDENTIAL_REVALIDATION_HOURS',
      env['AB_CREDENTIAL_REVALIDATION_HOURS'],
      24,
      0,
      8_760,
    ),
    passthrough: onOff('AB_PASSTHROUGH', env['AB_PASSTHROUGH'], false),
    allowHttpInstances: onOff('AB_ALLOW_HTTP_INSTANCES', env['AB_ALLOW_HTTP_INSTANCES'], false),
    publicToolCatalog: onOff('AB_PUBLIC_TOOL_CATALOG', env['AB_PUBLIC_TOOL_CATALOG'], false),
    writeTools: onOff('AB_WRITE_TOOLS', env['AB_WRITE_TOOLS'], false),
    writeRates: {
      perGrant: int(
        'AB_WRITE_RATE_PER_GRANT_HOURLY',
        env['AB_WRITE_RATE_PER_GRANT_HOURLY'],
        DEFAULT_WRITE_RATE_LIMITS.perGrant,
        1,
        1_000,
      ),
      deployment: int(
        'AB_WRITE_RATE_DEPLOYMENT_HOURLY',
        env['AB_WRITE_RATE_DEPLOYMENT_HOURLY'],
        defaults.writeDeploymentRate ?? DEFAULT_WRITE_RATE_LIMITS.deployment ?? 200,
        1,
        10_000,
      ),
    },
    queryCache: {
      ttlSeconds: int('AB_QUERY_CACHE_TTL', env['AB_QUERY_CACHE_TTL'], 0, 0, MAX_QUERY_CACHE_TTL_SECONDS),
      edge: onOff('AB_QUERY_CACHE_EDGE', env['AB_QUERY_CACHE_EDGE'], false),
    },
    ...(identity === null ? {} : { identity }),
    ...(oauth === null ? {} : { oauth }),
    session: parseSessionSettings(env),
  };
}

/** `AB_SESSION_*` and `AB_LOGOUT_CLEAR_SITE_DATA` (P4-02). Bad values name the variable, never the value. */
export function parseSessionSettings(env: Env): SessionOptions & { timeouts: SessionTimeouts } {
  const idle = settingInteger('AB_SESSION_IDLE_MINUTES', env['AB_SESSION_IDLE_MINUTES'], 30, 5, 1_440);
  const hours = settingInteger('AB_SESSION_MAX_HOURS', env['AB_SESSION_MAX_HOURS'], 12, 1, 168);
  if (idle > hours * 60) {
    throw new SettingsError('AB_SESSION_IDLE_MINUTES must not exceed AB_SESSION_MAX_HOURS.');
  }
  const clear = env['AB_LOGOUT_CLEAR_SITE_DATA'] ?? 'cookies';
  if (clear !== '' && clear !== 'cookies' && clear !== 'off') {
    throw new SettingsError('AB_LOGOUT_CLEAR_SITE_DATA must be cookies or off.');
  }
  return {
    timeouts: { idleMs: idle * 60_000, absoluteMs: hours * 3_600_000 },
    maxPerUser: settingInteger('AB_SESSION_MAX_PER_USER', env['AB_SESSION_MAX_PER_USER'], 20, 1, 100),
    clearSiteData: clear !== 'off',
  };
}

/** The warnings both hosts log at start for risky but valid settings. */
export function settingWarnings(env: Env, settings: ServerSettings): string[] {
  const warnings: string[] = [];
  if (settings.writeTools) {
    warnings.push(
      'AB_WRITE_TOOLS is on: owners can enable write tools per workspace and grant; every write needs a person to approve it.',
    );
  }
  if (!settings.rateLimits.enabled) {
    warnings.push('AB_RATE_LIMIT is off: no request, token or authentication-failure limits.');
  }
  if (settings.allowHttpInstances) {
    warnings.push(
      'AB_ALLOW_HTTP_INSTANCES is on: plain-HTTP loopback instance URLs are accepted (tests only).',
    );
  }
  if (settings.publicToolCatalog) {
    warnings.push(
      'AB_PUBLIC_TOOL_CATALOG is on: anyone who can reach the server can list its read-only tools without signing in.',
    );
  }
  if (settings.passthrough) {
    warnings.push(
      'AB_PASSTHROUGH is on: pass-through workspaces accept any valid Agility token of their instance.',
    );
  }
  if (settings.queryCache.edge && settings.queryCache.ttlSeconds === 0) {
    warnings.push('AB_QUERY_CACHE_EDGE is on but AB_QUERY_CACHE_TTL is 0: the query cache is off.');
  }
  warnings.push(...(settings.identity?.warnings ?? []));
  return warnings;
}

/**
 * Revalidates a credential after 3 consecutive `AB_AGILITY_AUTH` errors (a revoked token), at most once per 10 minutes
 * per credential, so a dead token is marked invalid instead of failing every call (P2-13, A10). Returns the
 * revalidation it started, for the host to keep alive.
 */
export function revalidateOnAuthErrors(
  services: AccessServices,
  logger: Logger,
  now: () => number = Date.now,
): (credentialId: string, errorCode: string | null) => Promise<void> | undefined {
  const streaks = new Map<string, number>();
  const last = new Map<string, number>();
  return (credentialId, errorCode) => {
    if (errorCode !== 'AB_AGILITY_AUTH') {
      streaks.delete(credentialId);
      return undefined;
    }
    const n = (streaks.get(credentialId) ?? 0) + 1;
    streaks.set(credentialId, n);
    if (n < 3 || now() - (last.get(credentialId) ?? 0) < 600_000) return undefined;
    last.set(credentialId, now());
    streaks.delete(credentialId);
    return services.credentials
      .validate(credentialId)
      .then((c) => {
        logger.warn('credential revalidated after Agility refused it', {
          credential: c.id,
          status: c.validationStatus,
        });
      })
      .catch((error: unknown) => {
        logger.error('credential revalidation failed', { error: (error as Error).name });
      });
  };
}

export interface ServerParts {
  readonly settings: ServerSettings;
  readonly storage: Storage;
  readonly keyring: Keyring;
  readonly host: HostServices;
  readonly logger: Logger;
  /** The counters behind the rate limits (in memory on Node; P3-04 adds the Workers binding). */
  readonly limiter: RateLimiter;
  readonly version: string;
  /** `process` on Node, `request` on Workers (L-096). */
  readonly isolation: 'process' | 'request';
  /** Keeps work alive after the response (Workers: `waitUntil`). */
  readonly background?: (c: Context, work: Promise<unknown>) => void;
  readonly clientIp: (c: Context) => string;
  /** Whether a pass-through request reached the server over HTTPS (P2-14). */
  readonly passthroughSecure: (c: Context) => boolean;
  /** The break-glass admin token; absent = no admin API (404). */
  readonly adminVerifier?: AdminTokenVerifier;
  /** Limits no workspace or grant may exceed on this runtime (Workers Free, P3-03). */
  readonly ceilings?: DeploymentLimits['ceilings'];
  /**
   * The `fetch` for identity providers: discovery, keys, token and user lookups (P4-01). These are not Agility requests.
   * Node pins it to public addresses at connect time; default: the global `fetch`.
   */
  readonly identityFetch?: FetchLike;
  /**
   * The guarded `fetch` for OAuth client metadata documents (P5-03): it must refuse non-public destinations and not follow
   * redirects (Node: connect-time address check; Workers: `global_fetch_strictly_public`). Absent = CIMD off.
   */
  readonly clientMetadataFetch?: ClientMetadataFetch;
  /** Refuses an instance host by throwing (Node: one resolving to a private address, P2-19). */
  readonly checkInstanceHost?: (hostname: string) => Promise<void>;
  /**
   * The shared query cache tier (P8-01), used when `AB_QUERY_CACHE_EDGE=on`: encrypted bodies in the Workers Cache API.
   * Absent on Node, where the setting is reported and ignored.
   */
  readonly queryCacheShared?: SharedTier;
  /** The tool registry built once (Workers: at module scope, P3-14). */
  readonly registry?: ToolRegistry;
  /** A stand-in for the interactive step of `/oauth/authorize` (tests); default: the built-in consent screen (P5-04). */
  readonly oauthConsent?: OAuthConsentHandler;
}

export interface AssembledServer {
  readonly app: HttpApp;
  readonly audit: AuditWriter;
  readonly services: AccessServices;
}

/** The app both hosts serve, with audit, admin API, rate limits and pass-through as configured. */
export function assembleServer(parts: ServerParts): AssembledServer {
  const { settings, storage, keyring, host, logger } = parts;
  const tools = new Map(CORE_TOOLS.map((t) => [t.name, { kind: t.kind, group: t.group }]));
  const audit = new AuditWriter({
    storage,
    logger,
    clock: host.clock,
    random: host.random,
    ...(parts.isolation === 'request' ? { detached: true } : {}),
  });
  const validator = credentialValidator(host);
  const services = accessServices({
    storage,
    keyring,
    tools,
    environment: settings.environment,
    validator,
    instanceUrls: {
      httpLoopback: settings.allowHttpInstances,
      ...(parts.checkInstanceHost === undefined ? {} : { checkHost: parts.checkInstanceHost }),
    },
  });
  if (settings.oauth !== undefined && parts.oauthConsent === undefined && settings.identity === undefined) {
    throw new SettingsError(
      'AB_OAUTH=on needs sign-in: people approve apps on a consent screen after signing in.',
    );
  }
  // The query cache (P8-01): entry ids are keyed hashes under the keyring's cache-id purpose; off unless a TTL is set.
  const queryCache =
    settings.queryCache.ttlSeconds === 0
      ? undefined
      : new QueryCache({
          ttlMs: settings.queryCache.ttlSeconds * 1000,
          mac: (data) => keyring.mac(KeyPurpose.CacheId, data),
          clock: host.clock,
          logger,
          ...(settings.queryCache.edge && parts.queryCacheShared !== undefined
            ? { shared: parts.queryCacheShared }
            : {}),
        });
  if (settings.queryCache.edge && parts.queryCacheShared === undefined && queryCache !== undefined) {
    logger.warn(
      'AB_QUERY_CACHE_EDGE is on but this host has no shared tier: the query cache is in memory only.',
    );
  }
  const authErrors = revalidateOnAuthErrors(services, logger, () => host.clock.now());
  const app = createHttpApp({
    storage,
    keyring,
    access: {
      tools,
      writesEnabled: settings.writeTools,
      environment: settings.environment,
      limits: {
        defaults: {
          ...DEFAULT_LIMITS,
          maxResponseBytes: settings.maxResponseBytes,
          callBudget: settings.callBudget,
          genericQuery: true,
        },
        ceilings: parts.ceilings ?? {},
      },
    },
    tools: CORE_TOOLS,
    ...(settings.writeTools
      ? {
          writes: createHttpWrites({
            storage,
            audit,
            keyring,
            clock: host.clock,
            // The approval page lives in the signed-in panel: only offered where sign-in is configured (P7-02).
            ...(settings.identity === undefined
              ? {}
              : {
                  panelOrigin: new URL(settings.identity.publicUrl).origin,
                  auditAdmin: (change: AdminChange) => audit.admin(change),
                }),
            limits: { perGrant: settings.writeRates.perGrant, deployment: settings.writeRates.deployment },
            logger,
          }),
        }
      : {}),
    services: { ...host, ...(queryCache === undefined ? {} : { queryCache }) },
    ...(settings.publicUrl === undefined ? {} : { publicUrl: settings.publicUrl }),
    allowedHosts: settings.allowedHosts,
    allowedOrigins: settings.allowedOrigins,
    accessCacheTtlSeconds: settings.accessCacheTtlSeconds,
    limits: createRequestLimits(parts.limiter, settings.rateLimits, logger),
    ...(settings.passthrough ? { passthrough: { validator, secure: parts.passthroughSecure } } : {}),
    ...(settings.publicToolCatalog ? { publicToolCatalog: true } : {}),
    // The admin API exists with the break-glass token, with sign-in (browser sessions, P4-02), or both.
    ...(parts.adminVerifier === undefined && settings.identity === undefined
      ? {}
      : {
          admin: {
            services,
            audit,
            writeRateCap: settings.writeRates.perGrant,
            authenticate:
              parts.adminVerifier === undefined
                ? async () => null
                : adminTokenAuthenticator(parts.adminVerifier),
          },
        }),
    session: settings.session,
    ...(settings.identity === undefined
      ? {}
      : {
          identity: {
            publicUrl: settings.identity.publicUrl,
            providers: createIdentityProviders(settings.identity, {
              ...(parts.identityFetch === undefined ? {} : { fetch: parts.identityFetch }),
              clock: host.clock,
            }),
            policy: settings.identity.policy,
            audit: (event) => audit.login(event),
            auditAdmin: (change) => audit.admin(change),
          },
        }),
    ...(settings.oauth === undefined
      ? {}
      : {
          oauth: {
            ...settings.oauth,
            ...(parts.oauthConsent === undefined ? {} : { consent: parts.oauthConsent }),
            ...(parts.clientMetadataFetch === undefined
              ? {}
              : { clientMetadataFetch: parts.clientMetadataFetch }),
            audit: (event) => audit.oauth(event),
          },
        }),
    clientIp: parts.clientIp,
    observer: audit.observer({
      toolCall: (e) => authErrors(e.access.credential.id, e.errorCode),
      request: (e) => {
        logger.info('request', {
          requestId: e.requestId,
          workspace: e.slug,
          status: e.status,
          method: e.mcp?.method ?? null,
          kind: e.mcp?.kind ?? null,
          tool: e.mcp?.tool ?? null,
          durationMs: e.durationMs,
          ...(e.refusal === null ? {} : { refusal: e.refusal }),
        });
      },
    }),
    isolation: parts.isolation,
    ...(parts.registry === undefined ? {} : { registry: parts.registry }),
    ...(parts.background === undefined ? {} : { background: parts.background }),
    version: parts.version,
  });
  return { app, audit, services };
}
