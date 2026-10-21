// SPDX-License-Identifier: Apache-2.0
// `agility-bridge serve` (P2-06, ARCHITECTURE §3 mode C): the HTTP server on Node with SQLite storage, encrypted
// tokens and per-workspace MCP endpoints. Configuration only from the environment, never flags (L-026).
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import {
  type AccessServices,
  AdminTokenVerifier,
  accessServices,
  credentialValidator,
  Keyring,
  verifyKeyring,
} from '@agility-bridge/auth';
import {
  CircuitBreakers,
  CORE_TOOLS,
  CredentialLimiters,
  createLogger,
  DEFAULT_LIMITS,
  type FetchLike,
  type Logger,
  type LogLevel,
  MetadataService,
  stderrSink,
  systemClock,
  webCryptoRandom,
} from '@agility-bridge/core';
import {
  AuditWriter,
  adminTokenAuthenticator,
  clientAddress,
  createHttpApp,
  createRequestLimits,
  DEFAULT_RATE_LIMITS,
  type HttpApp,
  MemoryRateLimiter,
  type RateLimitConfig,
  scheduleAuditRetention,
} from '@agility-bridge/http-app';
import {
  openSqliteStorage,
  readSecretFile,
  type SqliteStorage,
  UnsafeFileError,
} from '@agility-bridge/storage-sqlite';
import { serve as serveNode } from '@hono/node-server';
import pkg from '../package.json' with { type: 'json' };
import { createNodeFetch } from './agility-fetch.ts';
import { ConfigError, checkEnvNames, DEFAULTS } from './config.ts';
import { isInside, readMasterKeys } from './master-key.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface ServeConfig {
  readonly dbPath: string;
  readonly host: string;
  readonly port: number;
  readonly publicUrl?: string;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly accessCacheTtlSeconds: number;
  readonly environment: 'live' | 'test';
  readonly callBudget: number;
  readonly maxResponseBytes: number;
  readonly logLevel: LogLevel;
  readonly rateLimits: RateLimitConfig;
  /** Proxies in front whose `X-Forwarded-For` entries are trusted (default 0). */
  readonly trustedProxyHops: number;
  /** Days audit rows are kept (default 90; 0 keeps them forever). */
  readonly auditRetentionDays: number;
  /** Hours between credential revalidations (default 24; 0 = never). */
  readonly revalidationHours: number;
  /** `AB_PASSTHROUGH=on`: pass-through workspaces accept the caller's own Agility token (P2-14, off by default). */
  readonly passthrough: boolean;
}

/** The default data directory (`$XDG_DATA_HOME` or `~/.local/share`; `%LOCALAPPDATA%` on Windows). */
export function dataDir(
  env: Env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const base =
    platform === 'win32'
      ? (env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'))
      : (env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'));
  return join(base, 'agility-bridge');
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function integer(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new ConfigError(`${name} must be an integer from ${min} to ${max}.`);
  return n;
}

export function loadServeConfig(env: Env): ServeConfig {
  checkEnvNames(env);
  const level = env['AB_LOG_LEVEL'] ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(level))
    throw new ConfigError('AB_LOG_LEVEL must be debug, info, warn or error.');
  const environment = env['AB_ENVIRONMENT'] ?? 'production';
  if (environment !== 'production' && environment !== 'test') {
    throw new ConfigError('AB_ENVIRONMENT must be production (device tokens ab_live_…) or test (ab_test_…).');
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
      throw new ConfigError('AB_PUBLIC_URL must be the public origin, e.g. https://mcp.example.com.');
    }
  }
  for (const o of list(env['AB_ALLOWED_ORIGINS'])) {
    if (o === 'null' || !/^https?:\/\/[^/\s]+$/.test(o)) {
      throw new ConfigError(`AB_ALLOWED_ORIGINS has an invalid origin: "${o.slice(0, 60)}".`);
    }
  }
  const dbPath = env['AB_DB_PATH'] || join(env['AB_DATA_DIR'] || dataDir(env), 'agility-bridge.db');
  return {
    dbPath,
    host: env['AB_HOST'] || '127.0.0.1',
    port: integer('AB_PORT', env['AB_PORT'], 8787, 0, 65_535),
    ...(publicUrl === undefined ? {} : { publicUrl }),
    allowedHosts: list(env['AB_ALLOWED_HOSTS']),
    allowedOrigins: list(env['AB_ALLOWED_ORIGINS']),
    accessCacheTtlSeconds: integer('AB_ACCESS_CACHE_TTL', env['AB_ACCESS_CACHE_TTL'], 30, 0, 60),
    environment: environment === 'production' ? 'live' : 'test',
    callBudget: integer('AB_CALL_BUDGET', env['AB_CALL_BUDGET'], DEFAULTS.callBudget, 1, 10_000),
    maxResponseBytes: integer(
      'AB_LIMITS_MAX_RESPONSE_BYTES',
      env['AB_LIMITS_MAX_RESPONSE_BYTES'],
      DEFAULTS.maxResponseBytes,
      65_536,
      64 * 1024 * 1024,
    ),
    logLevel: level as LogLevel,
    rateLimits: {
      enabled: rateLimitSwitch(env['AB_RATE_LIMIT']),
      ipPerMinute: integer(
        'AB_RATE_LIMIT_IP_PER_MINUTE',
        env['AB_RATE_LIMIT_IP_PER_MINUTE'],
        DEFAULT_RATE_LIMITS.ipPerMinute,
        1,
        1_000_000,
      ),
      authFailuresPer5Minutes: integer(
        'AB_RATE_LIMIT_AUTH_FAILURES',
        env['AB_RATE_LIMIT_AUTH_FAILURES'],
        DEFAULT_RATE_LIMITS.authFailuresPer5Minutes,
        1,
        10_000,
      ),
      tokenPerMinute: integer(
        'AB_RATE_LIMIT_TOKEN_PER_MINUTE',
        env['AB_RATE_LIMIT_TOKEN_PER_MINUTE'],
        DEFAULT_RATE_LIMITS.tokenPerMinute,
        1,
        100_000,
      ),
      grantPerMinute: integer(
        'AB_RATE_LIMIT_GRANT_PER_MINUTE',
        env['AB_RATE_LIMIT_GRANT_PER_MINUTE'],
        DEFAULT_RATE_LIMITS.grantPerMinute,
        1,
        100_000,
      ),
      validationsPerMinute: integer(
        'AB_RATE_LIMIT_VALIDATIONS_PER_MINUTE',
        env['AB_RATE_LIMIT_VALIDATIONS_PER_MINUTE'],
        DEFAULT_RATE_LIMITS.validationsPerMinute,
        1,
        10_000,
      ),
    },
    trustedProxyHops: integer('AB_TRUSTED_PROXY_HOPS', env['AB_TRUSTED_PROXY_HOPS'], 0, 0, 10),
    auditRetentionDays: integer('AB_AUDIT_RETENTION_DAYS', env['AB_AUDIT_RETENTION_DAYS'], 90, 0, 36_500),
    revalidationHours: integer(
      'AB_CREDENTIAL_REVALIDATION_HOURS',
      env['AB_CREDENTIAL_REVALIDATION_HOURS'],
      24,
      0,
      8_760,
    ),
    passthrough: onOff('AB_PASSTHROUGH', env['AB_PASSTHROUGH']),
  };
}

function onOff(name: string, value: string | undefined): boolean {
  if (value === undefined || value === '' || value === 'off') return false;
  if (value === 'on') return true;
  throw new ConfigError(`${name} must be on or off.`);
}

function rateLimitSwitch(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === 'on') return true;
  if (value === 'off') return false;
  throw new ConfigError('AB_RATE_LIMIT must be on or off.');
}

export interface RunningServer {
  readonly url: string;
  readonly app: HttpApp;
  readonly storage: SqliteStorage;
  readonly audit: AuditWriter;
  close(): Promise<void>;
}

/** Opens storage, checks the master key, and listens. Throws ConfigError before listening on any problem. */
export async function startServe(
  env: Env,
  options: { sink?: (line: string) => void } = {},
): Promise<RunningServer> {
  const config = loadServeConfig(env);
  const logger = createLogger({
    level: config.logLevel,
    sink: options.sink ?? stderrSink,
    fields: { mode: 'serve' },
  });
  if (env['AB_WRITE_TOOLS'] === 'on')
    logger.warn('AB_WRITE_TOOLS is on, but this version has no write tools.');
  if (!config.rateLimits.enabled) {
    logger.warn('AB_RATE_LIMIT is off: no request, token or authentication-failure limits.');
  }
  if (config.passthrough) {
    logger.warn(
      'AB_PASSTHROUGH is on: pass-through workspaces accept any valid Agility token of their instance.',
    );
  }
  const keys = readMasterKeys(env, { dataDir: dirname(config.dbPath) });
  const keyring = await Keyring.create(keys.current, keys.previous);
  const storage = await openSqliteStorage({ path: config.dbPath, onWarning: (m) => logger.warn(m) });
  try {
    const check = await verifyKeyring(storage, keyring);
    for (const w of check.warnings) logger.warn(w);
  } catch (error) {
    await storage.close();
    throw new ConfigError((error as Error).message);
  }

  let adminVerifier: AdminTokenVerifier | undefined;
  try {
    const adminToken = readAdminToken(env, dirname(config.dbPath));
    if (adminToken !== undefined) adminVerifier = await AdminTokenVerifier.create(adminToken);
  } catch (error) {
    await storage.close();
    throw error instanceof ConfigError
      ? error
      : new ConfigError(`AB_ADMIN_TOKEN: ${(error as Error).message}`);
  }
  const tools = new Map(CORE_TOOLS.map((t) => [t.name, { kind: t.kind, group: t.group }]));
  const audit = new AuditWriter({ storage, logger, clock: systemClock, random: webCryptoRandom });
  const stopRetention = scheduleAuditRetention(storage, config.auditRetentionDays, systemClock, logger);
  const hostServices = nodeHostServices(logger);
  const services = accessServices({
    storage,
    keyring,
    tools,
    environment: config.environment,
    validator: credentialValidator(hostServices),
  });
  const stopRevalidation = scheduleRevalidation(services, config.revalidationHours, logger);
  const authErrors = revalidateOnAuthErrors(services, logger);
  const app = createHttpApp({
    storage,
    keyring,
    access: {
      tools,
      writesEnabled: false,
      environment: config.environment,
      limits: {
        defaults: {
          ...DEFAULT_LIMITS,
          maxResponseBytes: config.maxResponseBytes,
          callBudget: config.callBudget,
          genericQuery: true,
        },
        ceilings: {},
      },
    },
    tools: CORE_TOOLS,
    services: hostServices,
    ...(config.publicUrl === undefined ? {} : { publicUrl: config.publicUrl }),
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedOrigins,
    accessCacheTtlSeconds: config.accessCacheTtlSeconds,
    limits: createRequestLimits(new MemoryRateLimiter(), config.rateLimits, logger),
    ...(config.passthrough
      ? {
          passthrough: {
            validator: credentialValidator(hostServices),
            // HTTPS only (P2-14). This server speaks plain HTTP, so only a trusted proxy can say the client used TLS;
            // the request URL's scheme is the client's choice (absolute-form targets, P2-17 review F1).
            secure: (c) => config.trustedProxyHops > 0 && c.req.header('x-forwarded-proto') === 'https',
          },
        }
      : {}),
    ...(adminVerifier === undefined
      ? {}
      : {
          admin: {
            services,
            audit,
            authenticate: adminTokenAuthenticator(adminVerifier),
          },
        }),
    clientIp: (c) =>
      clientAddress(
        (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket
          ?.remoteAddress,
        c.req.header('x-forwarded-for'),
        config.trustedProxyHops,
      ),
    observer: audit.observer({
      toolCall: (e) => authErrors(e.access.credential.id, e.errorCode),
      request: (e) =>
        logger.info('request', {
          requestId: e.requestId,
          workspace: e.slug,
          status: e.status,
          method: e.mcp?.method ?? null,
          kind: e.mcp?.kind ?? null,
          tool: e.mcp?.tool ?? null,
          durationMs: e.durationMs,
          ...(e.refusal === null ? {} : { refusal: e.refusal }),
        }),
    }),
    version: pkg.version,
  });

  const server = await new Promise<ReturnType<typeof serveNode>>((resolve, reject) => {
    const s = serveNode({ fetch: originFormOnly(app.fetch), port: config.port, hostname: config.host }, () =>
      resolve(s),
    );
    s.once('error', reject);
  });
  // Bound slow clients at the socket too (L-084); the app bounds the exchange at 180 s.
  const node = server as unknown as {
    headersTimeout: number;
    requestTimeout: number;
    keepAliveTimeout: number;
  };
  node.headersTimeout = 20_000;
  node.requestTimeout = 60_000;
  node.keepAliveTimeout = 5_000;
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  const url = `http://${host}:${port}`;
  logger.info('serving', {
    url,
    publicUrl: config.publicUrl ?? null,
    database: config.dbPath,
    adminApi: adminVerifier !== undefined,
  });
  return {
    url,
    app,
    storage,
    audit,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      stopRetention();
      stopRevalidation();
      await audit.flush();
      await storage.close();
    },
  };
}

/** `AB_ADMIN_TOKEN` or `AB_ADMIN_TOKEN_FILE` (a 0600 file outside the data directory), or undefined: no admin API. */
type NodeFetch = (
  request: Request,
  env: { incoming?: { url?: string | undefined } },
) => Response | Promise<Response>;

/**
 * Refuses request targets that are not origin-form (`/path`): an absolute-form target (`GET http://host/…`) or `*`
 * would let the client choose the URL the app sees, scheme and host included (P2-17 review F1).
 */
export function originFormOnly(fetch: NodeFetch): NodeFetch {
  return (request, env) => {
    const target = env?.incoming?.url;
    if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) {
      return new Response(JSON.stringify({ error: 'bad request' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return fetch(request, env);
  };
}

export function readAdminToken(env: Env, dataDir?: string): string | undefined {
  const value = env['AB_ADMIN_TOKEN'];
  const file = env['AB_ADMIN_TOKEN_FILE'];
  if (value && file) throw new ConfigError('Set AB_ADMIN_TOKEN or AB_ADMIN_TOKEN_FILE, not both.');
  if (file) {
    // Symbolic links resolved, like the master key's check (P2-17 review L1).
    if (dataDir !== undefined && isInside(file, dataDir)) {
      throw new ConfigError(
        'AB_ADMIN_TOKEN_FILE is inside the data directory; keep it away from the database and its backups.',
      );
    }
    try {
      return readSecretFile(file).trim();
    } catch (error) {
      if (error instanceof UnsafeFileError) throw new ConfigError(`AB_ADMIN_TOKEN_FILE: ${error.message}`);
      throw error;
    }
  }
  return value || undefined;
}

/** Per-process services for Agility calls: the `fetch` pinned to an instance's TLS (custom CA), limiters, breakers. */
export function nodeHostServices(logger: Logger) {
  const fetches = new Map<string, FetchLike>();
  return {
    fetchFor(instance: { id: string; tls: Record<string, unknown> | null }): FetchLike {
      const caFile =
        typeof instance.tls?.['caFile'] === 'string' ? (instance.tls['caFile'] as string) : undefined;
      const key = `${instance.id}|${caFile ?? ''}`;
      let f = fetches.get(key);
      if (f === undefined) {
        f = createNodeFetch(caFile === undefined ? {} : { caFile });
        fetches.set(key, f);
      }
      return f;
    },
    limiters: new CredentialLimiters({ concurrency: 5 }),
    breakers: new CircuitBreakers(),
    metadata: new MetadataService(),
    logger,
    clock: systemClock,
    random: webCryptoRandom,
  };
}

/** Revalidates credentials not checked for `hours` (P2-13); returns a stop function. */
function scheduleRevalidation(services: AccessServices, hours: number, logger: Logger): () => void {
  if (hours <= 0) return () => {};
  const everyMs = hours * 3_600_000;
  const run = () =>
    services.credentials
      .revalidate(Date.now() - everyMs)
      .then((n) => {
        if (n > 0) logger.info('credentials revalidated', { count: n });
      })
      .catch((error: unknown) =>
        logger.error('credential revalidation failed', { error: (error as Error).name }),
      );
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, Math.min(everyMs, 3_600_000));
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

/**
 * Revalidates a credential after 3 consecutive `AB_AGILITY_AUTH` errors (a revoked token), at most once per 10 minutes
 * per credential, so a dead token is marked invalid instead of failing every call (P2-13, A10).
 */
export function revalidateOnAuthErrors(
  services: AccessServices,
  logger: Logger,
  now: () => number = Date.now,
): (credentialId: string, errorCode: string | null) => void {
  const streaks = new Map<string, number>();
  const last = new Map<string, number>();
  return (credentialId, errorCode) => {
    if (errorCode !== 'AB_AGILITY_AUTH') {
      streaks.delete(credentialId);
      return;
    }
    const n = (streaks.get(credentialId) ?? 0) + 1;
    streaks.set(credentialId, n);
    if (n < 3 || now() - (last.get(credentialId) ?? 0) < 600_000) return;
    last.set(credentialId, now());
    streaks.delete(credentialId);
    services.credentials
      .validate(credentialId)
      .then((c) =>
        logger.warn('credential revalidated after Agility refused it', {
          credential: c.id,
          status: c.validationStatus,
        }),
      )
      .catch((error: unknown) =>
        logger.error('credential revalidation failed', { error: (error as Error).name }),
      );
  };
}
