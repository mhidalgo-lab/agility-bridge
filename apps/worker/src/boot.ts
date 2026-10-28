// SPDX-License-Identifier: Apache-2.0
// Boot of the Worker (P3-01): settings, keyring, D1 storage with migrations, key check, and the app `serve` also runs.
// Each boot runs inside one request and completes before it is cached (L-096): a concurrent request boots on its own
// instead of awaiting another request's boot.
import {
  type AccessServices,
  AdminTokenVerifier,
  KeyPurpose,
  Keyring,
  verifyKeyring,
} from '@agility-bridge/auth';
import {
  CircuitBreakers,
  CORE_TOOLS,
  CredentialLimiters,
  createLogger,
  type Logger,
  MetadataService,
  prewarmToolSchemas,
  systemClock,
  ToolRegistry,
  webCryptoRandom,
} from '@agility-bridge/core';
import {
  assembleServer,
  type HostFeatures,
  type HttpApp,
  MemoryRateLimiter,
  type OAuthConsentHandler,
  parseServerSettings,
  SERVER_SETTING_NAMES,
  type ServerSettings,
  type SettingDefaults,
  settingWarnings,
} from '@agility-bridge/http-app';
import { createD1Driver, type D1Database, openSqlStorage, type Storage } from '@agility-bridge/storage';
import { strictlyPublicClientMetadataFetch } from './cimd-fetch.ts';
import { BackstopRateLimiter, type RateLimitBinding } from './rate-limit.ts';

/** The Worker's bindings: `DB` (D1), the rate-limit backstops, the secrets and the `AB_*` variables. */
export interface WorkerEnv {
  readonly DB?: D1Database;
  readonly RL_IP?: RateLimitBinding;
  readonly RL_AUTH?: RateLimitBinding;
  readonly [name: string]: unknown;
}

export type WorkersPlan = 'free' | 'paid';

/**
 * Presets per Workers plan (ADR-0010, P3-03). Free allows 50 subrequests per request, so 45 Agility requests per call
 * and 512 KiB per response are also ceilings there: no setting, workspace or grant goes above them.
 */
export const PLAN_PRESETS: Readonly<Record<WorkersPlan, SettingDefaults & { readonly ceiling: boolean }>> =
  Object.freeze({
    free: { callBudget: 45, maxResponseBytes: 512 * 1024, ceiling: true },
    paid: { callBudget: 1_000, maxResponseBytes: 8 * 1024 * 1024, ceiling: false },
  });

/**
 * The tools with their converted JSON Schemas, built when the module loads: Workers run module scope at startup, under
 * its own limit, not in the first request's CPU budget (P3-14, L-020). A completed value, shared by every request.
 */
const REGISTRY = (() => {
  const registry = new ToolRegistry();
  for (const tool of CORE_TOOLS) registry.register(tool);
  // And the JSON Schemas `tools/list` hands out, cached per isolate (L-020).
  prewarmToolSchemas(CORE_TOOLS);
  return registry;
})();

/** Settings only the Worker reads, and its secrets (never `vars`, P3-05). */
const WORKER_ONLY = ['AB_PLAN', 'AB_MASTER_KEY', 'AB_MASTER_KEY_PREVIOUS', 'AB_ADMIN_TOKEN'];
const KNOWN = new Set([...SERVER_SETTING_NAMES, ...WORKER_ONLY]);

/** `AB_PLAN` (default `free`). */
export function workersPlan(settings: Readonly<Record<string, string>>): WorkersPlan {
  const plan = settings['AB_PLAN'] ?? 'free';
  if (plan !== 'free' && plan !== 'paid') throw new BootError('AB_PLAN must be free or paid.');
  return plan;
}

/** The boot failed for a reason the operator must fix; the message names a setting, never a value. */
export class BootError extends Error {
  override name = 'BootError';
}

/** What the scheduled jobs use (P3-08). */
export interface JobContext {
  readonly storage: Storage;
  readonly keyring: Keyring;
  readonly services: AccessServices;
  readonly settings: ServerSettings;
  readonly logger: Logger;
}

export interface Booted {
  readonly app: HttpApp;
  readonly logger: Logger;
  readonly jobs: JobContext;
}

/** The `AB_*` string values of the environment; anything else with the prefix is a typo or a Node-only setting. */
export function workerSettings(env: WorkerEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('AB_')) continue;
    if (!KNOWN.has(name))
      throw new BootError(`Unknown or unsupported setting ${name.slice(0, 64)} on Workers.`);
    if (typeof value !== 'string') throw new BootError(`${name} must be a text variable or secret.`);
    out[name] = value;
  }
  return out;
}

export async function boot(
  env: WorkerEnv,
  version: string,
  /** A stand-in for the OAuth consent step (tests); the shipped Worker uses the built-in screen (P5-04). */
  oauthConsent?: OAuthConsentHandler,
): Promise<Booted> {
  const settingsEnv = workerSettings(env);
  const plan = workersPlan(settingsEnv);
  const preset = PLAN_PRESETS[plan];
  const features: HostFeatures = { oauthConsent: oauthConsent !== undefined };
  const settings = parseServerSettings(settingsEnv, preset, features);
  if (preset.ceiling && settings.callBudget > preset.callBudget) {
    throw new BootError(`AB_CALL_BUDGET above ${preset.callBudget} does not fit the Workers ${plan} plan.`);
  }
  if (preset.ceiling && settings.maxResponseBytes > preset.maxResponseBytes) {
    throw new BootError(
      `AB_LIMITS_MAX_RESPONSE_BYTES above ${preset.maxResponseBytes} does not fit the Workers ${plan} plan.`,
    );
  }
  const logger = createLogger({
    level: settings.logLevel,
    sink: (line) => console.error(line),
    fields: { mode: 'worker' },
  });
  for (const warning of settingWarnings(settingsEnv, settings)) logger.warn(warning);
  if (env.DB === undefined) throw new BootError('The D1 binding DB is missing.');
  if (settings.rateLimits.enabled && (env.RL_IP === undefined || env.RL_AUTH === undefined)) {
    logger.warn('Rate limit bindings RL_IP and RL_AUTH are missing: limits count per isolate only.');
  }
  const current = settingsEnv['AB_MASTER_KEY'];
  if (current === undefined || current === '') throw new BootError('The secret AB_MASTER_KEY is missing.');
  const previous = settingsEnv['AB_MASTER_KEY_PREVIOUS'];
  const keyring = await Keyring.create(current, previous === '' ? undefined : previous);
  // Only the purposes requests use today: each derivation costs CPU in the first request (P3-14). A purpose used by
  // later phases (approvals, tasks, cache ids) must be added here, or a first use could be shared in flight (L-096).
  await keyring.warm([
    KeyPurpose.Credentials,
    KeyPurpose.KeyCheck,
    KeyPurpose.AuditIdentity,
    KeyPurpose.Login,
  ]);
  const storage = await openSqlStorage(createD1Driver(env.DB));
  const check = await verifyKeyring(storage, keyring);
  for (const w of check.warnings) logger.warn(w);
  const adminToken = settingsEnv['AB_ADMIN_TOKEN'];
  const adminVerifier =
    adminToken === undefined || adminToken === '' ? undefined : await AdminTokenVerifier.create(adminToken);

  const host = {
    // Workers trust public CAs only (ADR-0014); the core client refuses redirects and caps bytes.
    fetchFor: () => (request: Request) => fetch(request),
    limiters: new CredentialLimiters({ concurrency: 6, perCall: true }),
    breakers: new CircuitBreakers(),
    // Asset types outlive the isolate in D1 (P6-39): a cold isolate reads them instead of asking Agility again.
    metadata: new MetadataService({
      shareInflight: false,
      store: {
        get: (key) => storage.kv.get(key),
        set: (key, value, expiresAt) => storage.kv.set(key, value, { expiresAt }),
      },
    }),
    logger,
    clock: systemClock,
    random: webCryptoRandom,
  };
  // Client metadata documents (P5-03) only where the platform guarantees a public-only fetch.
  const clientMetadataFetch = settings.oauth === undefined ? null : strictlyPublicClientMetadataFetch();
  if (
    settings.oauth !== undefined &&
    clientMetadataFetch === null &&
    settings.oauth.clientMetadataDocuments !== false
  ) {
    logger.warn(
      'OAuth client metadata documents are off: the global_fetch_strictly_public compatibility flag is not set. Dynamic registration still works.',
    );
  }
  const { app, services } = assembleServer({
    settings,
    storage,
    keyring,
    host,
    logger,
    // Exact per isolate, with Cloudflare's binding as a backstop across isolates (P3-04).
    limiter: new BackstopRateLimiter(
      new MemoryRateLimiter(),
      {
        ...(env.RL_IP === undefined ? {} : { ip: env.RL_IP }),
        ...(env.RL_AUTH === undefined ? {} : { authFailures: env.RL_AUTH }),
      },
      logger,
    ),
    version,
    isolation: 'request',
    registry: REGISTRY,
    background: (c, work) => c.executionCtx.waitUntil(work),
    ...(oauthConsent === undefined ? {} : { oauthConsent }),
    ...(clientMetadataFetch === null ? {} : { clientMetadataFetch }),
    ...(adminVerifier === undefined ? {} : { adminVerifier }),
    ...(preset.ceiling
      ? { ceilings: { callBudget: preset.callBudget, maxResponseBytes: preset.maxResponseBytes } }
      : {}),
    // Set by Cloudflare's edge for every request; a client cannot choose it.
    clientIp: (c) => c.req.header('cf-connecting-ip') ?? 'unknown',
    // Cloudflare terminates TLS, so the request URL's scheme is the one the client used.
    passthroughSecure: (c) => new URL(c.req.url).protocol === 'https:',
  });
  logger.info('booted', {
    plan,
    callBudget: settings.callBudget,
    adminApi: adminVerifier !== undefined || settings.identity !== undefined,
    publicUrl: settings.publicUrl ?? null,
  });
  return { app, logger, jobs: { storage, keyring, services, settings, logger } };
}
