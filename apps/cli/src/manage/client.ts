// SPDX-License-Identifier: Apache-2.0
// The two ways the management commands reach a deployment (P2-10): the admin API of a running server (remote, HTTPS,
// no redirects, the admin token), or the same admin API in process over the local SQLite database (local, acting as
// the break-glass owner, audit rows `via: cli`). Both speak the same requests, so results and audit rows match.
import { dirname } from 'node:path';
import {
  accessServices,
  credentialValidator,
  Keyring,
  providerIdp,
  revokeUserSessions,
  verifyKeyring,
} from '@agility-bridge/auth';
import { CORE_TOOLS, type Logger, systemClock, webCryptoRandom } from '@agility-bridge/core';
import { ADMIN_BASE, AuditWriter, createAdminApi } from '@agility-bridge/http-app';
import { openSqliteStorage, type SqliteStorage } from '@agility-bridge/storage-sqlite';
import { checkPublicHost } from '../agility-fetch.ts';
import { ConfigError } from '../config.ts';
import { readMasterKeys } from '../master-key.ts';
import { loadServeConfig, nodeHostServices } from '../serve.ts';

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface AdminClient {
  readonly mode: 'local' | 'remote';
  request(method: string, path: string, body?: unknown): Promise<ApiResponse>;
  close(): Promise<void>;
}

type Env = Readonly<Record<string, string | undefined>>;

/** The admin API in process over the local database (owner rights: the operator holds the database and the key). */
export async function localClient(
  env: Env,
  logger: Logger,
): Promise<AdminClient & { storage: SqliteStorage; keyring: Keyring }> {
  const config = loadServeConfig(env);
  const keys = readMasterKeys(env, { dataDir: dirname(config.dbPath) });
  const keyring = await Keyring.create(keys.current, keys.previous);
  const storage = await openSqliteStorage({ path: config.dbPath, onWarning: (m) => logger.warn(m) });
  try {
    for (const w of (await verifyKeyring(storage, keyring)).warnings) logger.warn(w);
  } catch (error) {
    await storage.close();
    throw new ConfigError((error as Error).message);
  }
  const tools = new Map(CORE_TOOLS.map((t) => [t.name, { kind: t.kind, group: t.group }]));
  const audit = new AuditWriter({ storage, logger, clock: systemClock, random: webCryptoRandom });
  const api = createAdminApi({
    services: accessServices({
      storage,
      keyring,
      tools,
      environment: config.environment,
      validator: credentialValidator(
        nodeHostServices(logger, { publicOnly: config.privateAddresses === 'refuse' }),
      ),
      // The same instance policy as the server (P2-19).
      instanceUrls: {
        httpLoopback: config.allowHttpInstances,
        ...(config.privateAddresses === 'refuse' ? { checkHost: checkPublicHost } : {}),
      },
    }),
    storage,
    tools,
    audit,
    onChange: () => {},
    authenticate: async () => ({ kind: 'break_glass' }),
    revokeUserSessions: (userId) => revokeUserSessions(storage.kv, userId),
    clientIp: () => 'local',
    logger,
    clock: systemClock,
    via: 'cli',
    keyring,
    ...(config.identity === undefined
      ? {}
      : {
          setupLinks: { publicUrl: config.identity.publicUrl },
          configuredIdps: config.identity.providers.map(providerIdp),
        }),
  });
  return {
    mode: 'local',
    storage,
    keyring,
    async request(method, path, body) {
      const res = await api.fetch(
        new Request(`http://local${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
        }),
      );
      return { status: res.status, body: await res.json() };
    },
    async close() {
      await audit.flush();
      await storage.close();
    },
  };
}

/** The admin API of a running server: `AB_ADMIN_URL` (HTTPS; HTTP only for loopback) and the admin token. */
export function remoteClient(baseUrl: string, adminToken: string): AdminClient {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError('AB_ADMIN_URL must be the server origin, e.g. https://mcp.example.com.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ConfigError('AB_ADMIN_URL must use HTTPS (plain HTTP only for localhost).');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new ConfigError('AB_ADMIN_URL must be an origin without credentials, query or fragment.');
  }
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}${ADMIN_BASE}`;
  return {
    mode: 'remote',
    async request(method, path, body) {
      const res = await fetch(`${base}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${adminToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (res.status >= 300 && res.status < 400) {
        throw new ConfigError(
          `The server answered with a redirect (${res.status}); check AB_ADMIN_URL. Not followed.`,
        );
      }
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text === '' ? null : JSON.parse(text);
      } catch {
        parsed = {
          error: { code: 'bad_response', message: `The server did not answer JSON (HTTP ${res.status}).` },
        };
      }
      return { status: res.status, body: parsed };
    },
    async close() {},
  };
}
