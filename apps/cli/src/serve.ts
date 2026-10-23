// SPDX-License-Identifier: Apache-2.0
// `agility-bridge serve` (P2-06, ARCHITECTURE §3 mode C): the HTTP server on Node with SQLite storage, encrypted
// tokens and per-workspace MCP endpoints. Configuration only from the environment, never flags (L-026).
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type AccessServices,
  AdminTokenVerifier,
  IDENTITY_SECRET_NAMES,
  Keyring,
  verifyKeyring,
} from '@agility-bridge/auth';
import {
  CircuitBreakers,
  CredentialLimiters,
  createLogger,
  type FetchLike,
  type Logger,
  MetadataService,
  stderrSink,
  systemClock,
  webCryptoRandom,
} from '@agility-bridge/core';
import {
  type AuditWriter,
  assembleServer,
  clientAddress,
  type HttpApp,
  MemoryRateLimiter,
  parseServerSettings,
  type ServerSettings,
  SettingsError,
  scheduleAuditRetention,
  settingInteger,
  settingWarnings,
} from '@agility-bridge/http-app';
import {
  openSqliteStorage,
  readSecretFile,
  type SqliteStorage,
  UnsafeFileError,
} from '@agility-bridge/storage-sqlite';
import { serve as serveNode } from '@hono/node-server';
import pkg from '../package.json' with { type: 'json' };
import { checkPublicHost, createNodeFetch } from './agility-fetch.ts';
import { ConfigError, checkEnvNames, DEFAULTS } from './config.ts';
import { isInside, readMasterKeys } from './master-key.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface ServeConfig extends ServerSettings {
  readonly dbPath: string;
  readonly host: string;
  readonly port: number;
  /** Proxies in front whose `X-Forwarded-For` entries are trusted (default 0). */
  readonly trustedProxyHops: number;
  /** `AB_INSTANCE_PRIVATE_ADDRESSES`: `refuse` limits instances to public addresses (P2-19; default `allow`). */
  readonly privateAddresses: 'allow' | 'refuse';
  /** `AB_IDENTITY_PRIVATE_ADDRESSES`: `allow` lets sign-in reach an identity provider on a private network (P4-01; default `refuse`). */
  readonly identityPrivateAddresses: 'allow' | 'refuse';
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

function privateAddressPolicy(value: string | undefined): 'allow' | 'refuse' {
  if (value === undefined || value === '' || value === 'allow') return 'allow';
  if (value === 'refuse') return 'refuse';
  throw new ConfigError('AB_INSTANCE_PRIVATE_ADDRESSES must be allow or refuse.');
}

function identityAddressPolicy(value: string | undefined): 'allow' | 'refuse' {
  if (value === undefined || value === '' || value === 'refuse') return 'refuse';
  if (value === 'allow') return 'allow';
  throw new ConfigError('AB_IDENTITY_PRIVATE_ADDRESSES must be allow or refuse.');
}

/**
 * The environment with each `<SECRET>_FILE` read into `<SECRET>` (a 0600 file outside the data directory, symbolic links
 * refused), so identity client secrets need not sit in the environment (P4-01). Both forms are refused; no message
 * carries a value.
 */
export function withSecretFiles(env: Env, dir: string): Env {
  const out: Record<string, string | undefined> = { ...env };
  for (const name of IDENTITY_SECRET_NAMES) {
    const file = env[`${name}_FILE`];
    if (file === undefined || file === '') continue;
    if (env[name] !== undefined && env[name] !== '') {
      throw new ConfigError(`Set ${name} or ${name}_FILE, not both.`);
    }
    if (isInside(file, dir)) {
      throw new ConfigError(
        `${name}_FILE is inside the data directory; keep it away from the database and its backups.`,
      );
    }
    try {
      out[name] = readSecretFile(file).trim();
    } catch (error) {
      if (error instanceof UnsafeFileError) throw new ConfigError(`${name}_FILE: ${error.message}`);
      throw error;
    }
  }
  return out;
}

/** The shared settings (checked by `parseServerSettings`, P3-01) plus the Node-only ones. */
export function loadServeConfig(env: Env): ServeConfig {
  checkEnvNames(env);
  try {
    const dbPath = env['AB_DB_PATH'] || join(env['AB_DATA_DIR'] || dataDir(env), 'agility-bridge.db');
    const settings = parseServerSettings(withSecretFiles(env, dirname(dbPath)), DEFAULTS);
    return {
      ...settings,
      dbPath,
      host: env['AB_HOST'] || '127.0.0.1',
      port: settingInteger('AB_PORT', env['AB_PORT'], 8787, 0, 65_535),
      trustedProxyHops: settingInteger('AB_TRUSTED_PROXY_HOPS', env['AB_TRUSTED_PROXY_HOPS'], 0, 0, 10),
      privateAddresses: privateAddressPolicy(env['AB_INSTANCE_PRIVATE_ADDRESSES']),
      identityPrivateAddresses: identityAddressPolicy(env['AB_IDENTITY_PRIVATE_ADDRESSES']),
    };
  } catch (error) {
    if (error instanceof SettingsError) throw new ConfigError(error.message);
    throw error;
  }
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
  for (const warning of settingWarnings(env, config)) logger.warn(warning);
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
  const hostServices = nodeHostServices(logger, { publicOnly: config.privateAddresses === 'refuse' });
  const { app, audit, services } = assembleServer({
    settings: config,
    storage,
    keyring,
    host: hostServices,
    logger,
    limiter: new MemoryRateLimiter(),
    version: pkg.version,
    isolation: 'process',
    ...(adminVerifier === undefined ? {} : { adminVerifier }),
    ...(config.privateAddresses === 'refuse' ? { checkInstanceHost: checkPublicHost } : {}),
    // Identity providers are reached over public addresses only, checked at connect time (THREAT_MODEL T11).
    identityFetch: createNodeFetch({ publicOnly: config.identityPrivateAddresses === 'refuse' }),
    clientIp: (c) =>
      clientAddress(
        (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket
          ?.remoteAddress,
        c.req.header('x-forwarded-for'),
        config.trustedProxyHops,
      ),
    // HTTPS only (P2-14). This server speaks plain HTTP, so only a trusted proxy can say the client used TLS; the
    // request URL's scheme is the client's choice (absolute-form targets, P2-17 review F1).
    passthroughSecure: (c) => config.trustedProxyHops > 0 && c.req.header('x-forwarded-proto') === 'https',
  });
  const stopRetention = scheduleAuditRetention(storage, config.auditRetentionDays, systemClock, logger);
  const stopRevalidation = scheduleRevalidation(services, config.revalidationHours, logger);

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
export function nodeHostServices(logger: Logger, options: { readonly publicOnly?: boolean } = {}) {
  const fetches = new Map<string, FetchLike>();
  return {
    fetchFor(instance: { id: string; tls: Record<string, unknown> | null }): FetchLike {
      const caFile =
        typeof instance.tls?.['caFile'] === 'string' ? (instance.tls['caFile'] as string) : undefined;
      const key = `${instance.id}|${caFile ?? ''}`;
      let f = fetches.get(key);
      if (f === undefined) {
        f = createNodeFetch({
          ...(caFile === undefined ? {} : { caFile }),
          ...(options.publicOnly === true ? { publicOnly: true } : {}),
        });
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
