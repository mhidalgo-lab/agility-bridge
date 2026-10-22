// SPDX-License-Identifier: Apache-2.0
// Boot of the Worker (P3-01): settings, keyring, D1 storage with migrations, key check, and the app `serve` also runs.
// Each boot runs inside one request and completes before it is cached (L-096): a concurrent request boots on its own
// instead of awaiting another request's boot.
import { AdminTokenVerifier, Keyring, verifyKeyring } from '@agility-bridge/auth';
import {
  CircuitBreakers,
  CredentialLimiters,
  createLogger,
  type Logger,
  MetadataService,
  systemClock,
  webCryptoRandom,
} from '@agility-bridge/core';
import {
  assembleServer,
  type HttpApp,
  MemoryRateLimiter,
  parseServerSettings,
  SERVER_SETTING_NAMES,
  type SettingDefaults,
  settingWarnings,
} from '@agility-bridge/http-app';
import { createD1Driver, type D1Database, openSqlStorage } from '@agility-bridge/storage';

/** The Worker's bindings: `DB` (D1), the secrets and the `AB_*` variables. */
export interface WorkerEnv {
  readonly DB?: D1Database;
  readonly [name: string]: unknown;
}

/** Workers Free presets (ADR-0010): 45 Agility requests per call, 512 KiB per response. P3-03 adds the Paid plan. */
export const WORKER_DEFAULTS: SettingDefaults = Object.freeze({
  callBudget: 45,
  maxResponseBytes: 512 * 1024,
});

/** Secrets the Worker reads besides the shared settings (never `vars`, P3-05). */
const WORKER_SECRETS = ['AB_MASTER_KEY', 'AB_MASTER_KEY_PREVIOUS', 'AB_ADMIN_TOKEN'];
const KNOWN = new Set([...SERVER_SETTING_NAMES, ...WORKER_SECRETS]);

/** The boot failed for a reason the operator must fix; the message names a setting, never a value. */
export class BootError extends Error {
  override name = 'BootError';
}

export interface Booted {
  readonly app: HttpApp;
  readonly logger: Logger;
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

export async function boot(env: WorkerEnv, version: string): Promise<Booted> {
  const settingsEnv = workerSettings(env);
  const settings = parseServerSettings(settingsEnv, WORKER_DEFAULTS);
  const logger = createLogger({
    level: settings.logLevel,
    sink: (line) => console.error(line),
    fields: { mode: 'worker' },
  });
  for (const warning of settingWarnings(settingsEnv, settings)) logger.warn(warning);
  if (env.DB === undefined) throw new BootError('The D1 binding DB is missing.');
  const current = settingsEnv['AB_MASTER_KEY'];
  if (current === undefined || current === '') throw new BootError('The secret AB_MASTER_KEY is missing.');
  const previous = settingsEnv['AB_MASTER_KEY_PREVIOUS'];
  const keyring = await Keyring.create(current, previous === '' ? undefined : previous);
  await keyring.warm();
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
    metadata: new MetadataService({ shareInflight: false }),
    logger,
    clock: systemClock,
    random: webCryptoRandom,
  };
  const { app } = assembleServer({
    settings,
    storage,
    keyring,
    host,
    logger,
    // Counters per isolate until P3-04 adds the rate-limiting binding.
    limiter: new MemoryRateLimiter(),
    version,
    isolation: 'request',
    background: (c, work) => c.executionCtx.waitUntil(work),
    ...(adminVerifier === undefined ? {} : { adminVerifier }),
    // Set by Cloudflare's edge for every request; a client cannot choose it.
    clientIp: (c) => c.req.header('cf-connecting-ip') ?? 'unknown',
    // Cloudflare terminates TLS, so the request URL's scheme is the one the client used.
    passthroughSecure: (c) => new URL(c.req.url).protocol === 'https:',
  });
  logger.info('booted', { adminApi: adminVerifier !== undefined, publicUrl: settings.publicUrl ?? null });
  return { app, logger };
}
