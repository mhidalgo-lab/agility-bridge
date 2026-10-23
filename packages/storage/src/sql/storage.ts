// SPDX-License-Identifier: Apache-2.0
// The Storage interface over any SqlDriver (node:sqlite, D1). Every conditional write is one statement whose outcome
// is read from its RETURNING rows, never from driver change counters (L-072, L-161).
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, type SQL, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { InvalidInputError, NotFoundError } from '../errors.ts';
import {
  checkId,
  checkSealedToken,
  checkSettingValue,
  checkStatsQuery,
  clampLimit,
  finishStats,
  prepareBind,
  prepareCreate,
  preparePatch,
  type TableName,
} from '../fields.ts';
import { checkIncrement, checkKey, checkKvValue, checkPrefix, isLive } from '../kv-rules.ts';
import * as schema from '../schema.ts';
import type {
  AccessBundle,
  AccessToken,
  AccessTokenPatch,
  AccessTokenRepository,
  AuditEntry,
  AuditQuery,
  AuditRepository,
  Credential,
  CredentialPatch,
  CredentialRepository,
  Grant,
  GrantPatch,
  GrantRepository,
  Instance,
  InstancePatch,
  InstanceRepository,
  JsonValue,
  KvIncrementOptions,
  KvSetOptions,
  KvStore,
  NewAccessToken,
  NewCredential,
  NewGrant,
  NewInstance,
  NewUser,
  NewWorkspace,
  Now,
  Repository,
  Setting,
  SettingsRepository,
  Storage,
  User,
  UserPatch,
  UserRepository,
  Workspace,
  WorkspacePatch,
  WorkspaceRepository,
} from '../types.ts';
import { mapSqlError, type SqlDriver, type SqlStatement } from './driver.ts';
import { migrate } from './migrate.ts';

export interface SqlStorageOptions {
  now?: Now;
}

type Db = ReturnType<typeof drizzle<typeof schema>>;
// biome-ignore lint/suspicious/noExplicitAny: Drizzle's table generics are not expressible for a generic repository
type IdTable = SQLiteTableWithColumns<any> & { id: SQLiteColumn; createdAt: SQLiteColumn };

async function guard<T>(table: string, operation: 'write' | 'delete', run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw mapSqlError(error, table, operation);
  }
}

function idRepository<T, New, Patch>(
  db: Db,
  now: Now,
  name: TableName,
  table: IdTable,
): Repository<T, New, Patch> & { list(where?: SQL): Promise<T[]> } {
  const hasUpdatedAt = 'updatedAt' in table;
  return {
    async get(id) {
      if (typeof id !== 'string' || id.length === 0) return null;
      const rows = await db.select().from(table).where(eq(table.id, id)).limit(1);
      return (rows[0] as T | undefined) ?? null;
    },
    async create(input) {
      const row = prepareCreate<Record<string, unknown>>(name, input as object, now());
      const rows = await guard(name, 'write', () => db.insert(table).values(row).returning());
      return rows[0] as T;
    },
    async update(id, patch) {
      checkId(name, id);
      const values = preparePatch<Record<string, unknown>>(name, patch as object);
      if (hasUpdatedAt) values['updatedAt'] = now();
      if (Object.keys(values).length === 0) {
        const rows = await db.select().from(table).where(eq(table.id, id)).limit(1);
        if (rows[0] === undefined) throw new NotFoundError(`No ${name} row with this id.`);
        return rows[0] as T;
      }
      const rows = await guard(name, 'write', () =>
        db.update(table).set(values).where(eq(table.id, id)).returning(),
      );
      if (rows[0] === undefined) throw new NotFoundError(`No ${name} row with this id.`);
      return rows[0] as T;
    },
    async delete(id) {
      checkId(name, id);
      const rows = await guard(name, 'delete', () =>
        db.delete(table).where(eq(table.id, id)).returning({ id: table.id }),
      );
      if (rows.length === 0) throw new NotFoundError(`No ${name} row with this id.`);
    },
    async list(where) {
      const query = db.select().from(table);
      const rows = await (where ? query.where(where) : query).orderBy(asc(table.createdAt), asc(table.id));
      return rows as T[];
    },
  };
}

/** Creates the storage over a migrated database (see `openSqlStorage`). */
export function createSqlStorage(driver: SqlDriver, options: SqlStorageOptions = {}): Storage {
  const now = options.now ?? Date.now;
  const db: Db = drizzle(
    (sql, params, method) => driver.query({ sql, params, method }),
    (batch) => driver.batch(batch),
    { schema },
  );
  const raw = async (sql: string, params: unknown[]): Promise<unknown[][]> =>
    (await driver.query({ sql, params, method: 'all' } satisfies SqlStatement)).rows as unknown[][];

  const userRepo = idRepository<User, NewUser, UserPatch>(db, now, 'users', schema.users);
  const users: UserRepository = {
    ...userRepo,
    async getByEmail(email) {
      if (typeof email !== 'string') return null;
      const rows = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email.toLowerCase()))
        .limit(1);
      return rows[0] ?? null;
    },
    async getByIdentity(idp, idpSubject) {
      const rows = await db
        .select()
        .from(schema.users)
        .where(and(eq(schema.users.idp, idp), eq(schema.users.idpSubject, idpSubject)))
        .limit(1);
      return rows[0] ?? null;
    },
    async bind(id, idp, idpSubject, patch = {}) {
      checkId('users', id);
      const values = prepareBind(patch, idp, idpSubject);
      values['updatedAt'] = now();
      // One conditional statement: it applies only to an enabled row with no identity, whoever else is binding it.
      const rows = await guard('users', 'write', () =>
        db
          .update(schema.users)
          .set(values)
          .where(
            and(
              eq(schema.users.id, id),
              isNull(schema.users.idp),
              isNull(schema.users.idpSubject),
              isNull(schema.users.disabledAt),
            ),
          )
          .returning(),
      );
      return rows[0] ?? null;
    },
    list: () => userRepo.list(),
  };

  const instanceRepo = idRepository<Instance, NewInstance, InstancePatch>(
    db,
    now,
    'instances',
    schema.instances,
  );
  const instances: InstanceRepository = { ...instanceRepo, list: () => instanceRepo.list() };

  const credentialRepo = idRepository<Credential, NewCredential, CredentialPatch>(
    db,
    now,
    'credentials',
    schema.credentials,
  );
  const credentials: CredentialRepository = {
    ...credentialRepo,
    list(filter = {}) {
      const c = schema.credentials;
      const where: SQL[] = [];
      if (filter.instanceId !== undefined) where.push(eq(c.instanceId, filter.instanceId));
      if (filter.ownerUserId === null) where.push(isNull(c.ownerUserId));
      else if (filter.ownerUserId !== undefined) where.push(eq(c.ownerUserId, filter.ownerUserId));
      if (filter.keyVersion !== undefined) where.push(eq(c.keyVersion, filter.keyVersion));
      return credentialRepo.list(and(...where));
    },
    async replaceSecret(id, expected, next) {
      checkId('credentials', id);
      checkSealedToken(expected);
      checkSealedToken(next);
      const c = schema.credentials;
      const rows = await guard('credentials', 'write', () =>
        db
          .update(c)
          .set({ tokenCiphertext: next.tokenCiphertext, tokenIv: next.tokenIv, keyVersion: next.keyVersion })
          .where(
            and(
              eq(c.id, id),
              eq(c.keyVersion, expected.keyVersion),
              eq(c.tokenCiphertext, expected.tokenCiphertext),
              eq(c.tokenIv, expected.tokenIv),
            ),
          )
          .returning({ id: c.id }),
      );
      return rows.length > 0;
    },
  };

  const workspaceRepo = idRepository<Workspace, NewWorkspace, WorkspacePatch>(
    db,
    now,
    'workspaces',
    schema.workspaces,
  );
  const workspaces: WorkspaceRepository = {
    ...workspaceRepo,
    async getBySlug(slug) {
      if (typeof slug !== 'string') return null;
      const rows = await db.select().from(schema.workspaces).where(eq(schema.workspaces.slug, slug)).limit(1);
      return rows[0] ?? null;
    },
    list(filter = {}) {
      return workspaceRepo.list(
        filter.instanceId === undefined ? undefined : eq(schema.workspaces.instanceId, filter.instanceId),
      );
    },
  };

  const grantRepo = idRepository<Grant, NewGrant, GrantPatch>(db, now, 'grants', schema.grants);
  const grants: GrantRepository = {
    ...grantRepo,
    list(filter = {}) {
      const g = schema.grants;
      const where: SQL[] = [];
      if (filter.workspaceId !== undefined) where.push(eq(g.workspaceId, filter.workspaceId));
      if (filter.userId !== undefined) where.push(eq(g.userId, filter.userId));
      if (filter.credentialId !== undefined) where.push(eq(g.credentialId, filter.credentialId));
      return grantRepo.list(and(...where));
    },
  };

  const tokenRepo = idRepository<AccessToken, NewAccessToken, AccessTokenPatch>(
    db,
    now,
    'access_tokens',
    schema.accessTokens,
  );
  const accessTokens: AccessTokenRepository = {
    ...tokenRepo,
    async getByHash(tokenHash) {
      if (typeof tokenHash !== 'string') return null;
      const rows = await db
        .select()
        .from(schema.accessTokens)
        .where(eq(schema.accessTokens.tokenHash, tokenHash))
        .limit(1);
      return rows[0] ?? null;
    },
    async bundleByHash(tokenHash) {
      if (typeof tokenHash !== 'string') {
        return { token: null, grant: null, workspace: null, user: null, instance: null, credential: null };
      }
      // Each record keyed by a subquery on the token hash, so the six reads go out as one batch (one D1 round trip).
      const { accessTokens: t, grants: g, workspaces: w, users: u, instances: i, credentials: c } = schema;
      const grantIds = db.select({ id: t.grantId }).from(t).where(eq(t.tokenHash, tokenHash));
      const workspaceIds = db.select({ id: g.workspaceId }).from(g).where(inArray(g.id, grantIds));
      const credentialIds = db
        .select({ id: sql<string>`coalesce(${g.credentialId}, ${w.defaultCredentialId})` })
        .from(g)
        .innerJoin(w, eq(w.id, g.workspaceId))
        .where(inArray(g.id, grantIds));
      const [tokens, grantRows, workspaceRows, userRows, instanceRows, credentialRows] = await db.batch([
        db.select().from(t).where(eq(t.tokenHash, tokenHash)).limit(1),
        db.select().from(g).where(inArray(g.id, grantIds)).limit(1),
        db.select().from(w).where(inArray(w.id, workspaceIds)).limit(1),
        db
          .select()
          .from(u)
          .where(inArray(u.id, db.select({ id: g.userId }).from(g).where(inArray(g.id, grantIds))))
          .limit(1),
        db
          .select()
          .from(i)
          .where(inArray(i.id, db.select({ id: w.instanceId }).from(w).where(inArray(w.id, workspaceIds))))
          .limit(1),
        db.select().from(c).where(inArray(c.id, credentialIds)).limit(1),
      ]);
      return {
        token: tokens[0] ?? null,
        grant: grantRows[0] ?? null,
        workspace: workspaceRows[0] ?? null,
        user: userRows[0] ?? null,
        instance: instanceRows[0] ?? null,
        credential: credentialRows[0] ?? null,
      } as AccessBundle;
    },
    list(filter = {}) {
      return tokenRepo.list(
        filter.grantId === undefined ? undefined : eq(schema.accessTokens.grantId, filter.grantId),
      );
    },
    async touch(id, minIntervalMs) {
      checkId('access_tokens', id);
      if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0) {
        throw new InvalidInputError('minIntervalMs must be an integer ≥ 0.');
      }
      const t = now();
      const a = schema.accessTokens;
      const rows = await db
        .update(a)
        .set({ lastUsedAt: t })
        .where(and(eq(a.id, id), or(isNull(a.lastUsedAt), lte(a.lastUsedAt, t - minIntervalMs))))
        .returning({ id: a.id });
      return rows.length > 0;
    },
  };

  const audit: AuditRepository = {
    async append(entry) {
      const row = prepareCreate<AuditEntry>('audit_log', entry, now());
      await guard('audit_log', 'write', () => db.insert(schema.auditLog).values(row));
    },
    async query(q: AuditQuery = {}) {
      const a = schema.auditLog;
      const limit = clampLimit(q.limit, 100, 1_000);
      const where: SQL[] = [];
      if (q.workspaceId !== undefined) where.push(eq(a.workspaceId, q.workspaceId));
      if (q.userId !== undefined) where.push(eq(a.userId, q.userId));
      if (q.kind !== undefined) where.push(eq(a.kind, q.kind));
      if (q.status !== undefined) where.push(eq(a.status, q.status));
      if (q.action !== undefined) where.push(eq(a.action, q.action));
      if (q.from !== undefined) where.push(gte(a.ts, q.from));
      if (q.to !== undefined) where.push(lt(a.ts, q.to));
      if (q.after !== undefined) {
        where.push(or(lt(a.ts, q.after.ts), and(eq(a.ts, q.after.ts), lt(a.id, q.after.id))) as SQL);
      }
      return (await db
        .select()
        .from(a)
        .where(and(...where))
        .orderBy(desc(a.ts), desc(a.id))
        .limit(limit)) as AuditEntry[];
    },
    async stats(q) {
      const { groupBy, limit, cap } = checkStatsQuery(q);
      // The key is one of five constant expressions, never caller text; every value is a bound parameter. The inner
      // select reads at most the scan cap of the window (newest first), so the work is bounded (L-097).
      const key = {
        tool: 'action',
        workspace: 'workspace_id',
        grant: 'grant_id',
        user: 'user_id',
        day: "strftime('%Y-%m-%d', ts / 1000, 'unixepoch')",
      }[groupBy];
      const params: unknown[] = [q.from ?? 0, q.to ?? Number.MAX_SAFE_INTEGER];
      let workspace = '';
      if (q.workspaceId !== undefined) {
        workspace = ' AND workspace_id = ?';
        params.push(q.workspaceId);
      }
      params.push(cap);
      const rows = await raw(
        `SELECT ${key} AS k, COUNT(*), SUM(status = 'error'), SUM(status = 'denied'), COALESCE(SUM(agility_requests), 0),
  COALESCE(SUM(duration_ms), 0), COUNT(duration_ms), MAX(duration_ms)
FROM (SELECT action, workspace_id, grant_id, user_id, ts, status, agility_requests, duration_ms FROM audit_log
  WHERE kind = 'tool_call' AND ts >= ? AND ts < ?${workspace} ORDER BY ts DESC, id DESC LIMIT ?)
GROUP BY k`,
        params,
      );
      return finishStats(
        rows.map((r) => ({
          key: r[0] === null ? null : String(r[0]),
          calls: Number(r[1]),
          errors: Number(r[2]),
          denied: Number(r[3]),
          agilityRequests: Number(r[4]),
          durationSumMs: Number(r[5]),
          durationCount: Number(r[6]),
          maxDurationMs: r[7] === null ? null : Number(r[7]),
        })),
        limit,
        cap,
      );
    },
    async purge(before, limit) {
      const n = clampLimit(limit, 1_000, 10_000);
      const rows = await raw(
        'DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE ts < ? ORDER BY ts, id LIMIT ?) RETURNING id',
        [before, n],
      );
      return rows.length;
    },
  };

  const toSetting = (row: { key: string; value: string; updatedAt: number }): Setting => ({
    key: row.key,
    value: JSON.parse(row.value) as JsonValue,
    updatedAt: row.updatedAt,
  });
  const settings: SettingsRepository = {
    async get(key) {
      const rows = await db.select().from(schema.settings).where(eq(schema.settings.key, key)).limit(1);
      return rows[0] ? toSetting(rows[0]) : null;
    },
    async set(key, value) {
      checkSettingValue(key, value);
      const row = { key, value: JSON.stringify(value), updatedAt: now() };
      const rows = await db
        .insert(schema.settings)
        .values(row)
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: row.value, updatedAt: row.updatedAt },
        })
        .returning();
      return toSetting(rows[0] as typeof row);
    },
    async delete(key) {
      const rows = await db
        .delete(schema.settings)
        .where(eq(schema.settings.key, key))
        .returning({ key: schema.settings.key });
      return rows.length > 0;
    },
    async list() {
      return (await db.select().from(schema.settings).orderBy(asc(schema.settings.key))).map(toSetting);
    },
  };

  const LIVE = '(expires_at IS NULL OR expires_at > ?)';
  const kv: KvStore = {
    async get(key) {
      checkKey(key);
      const rows = await raw(`SELECT value FROM kv WHERE key = ? AND ${LIVE}`, [key, now()]);
      return (rows[0]?.[0] as string | undefined) ?? null;
    },
    async set(key, value, options: KvSetOptions = {}) {
      const expiresAt = checkKvValue(key, value, options);
      await raw(
        'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at RETURNING key',
        [key, value, expiresAt],
      );
    },
    async setIfAbsent(key, value, options: KvSetOptions = {}) {
      const expiresAt = checkKvValue(key, value, options);
      const rows = await raw(
        'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at ' +
          'WHERE kv.expires_at IS NOT NULL AND kv.expires_at <= ? RETURNING key',
        [key, value, expiresAt, now()],
      );
      return rows.length > 0;
    },
    async take(key) {
      checkKey(key);
      // Deletes an expired entry too, but only a live one is returned.
      const row = (await raw('DELETE FROM kv WHERE key = ? RETURNING value, expires_at', [key]))[0];
      return row !== undefined && isLive(row[1] as number | null, now()) ? (row[0] as string) : null;
    },
    async delete(key) {
      checkKey(key);
      const row = (await raw('DELETE FROM kv WHERE key = ? RETURNING expires_at', [key]))[0];
      return row !== undefined && isLive(row[0] as number | null, now());
    },
    async increment(key, options: KvIncrementOptions = {}) {
      const { by, max, expiresAt } = checkIncrement(key, options);
      if (by > max) return null;
      const t = now();
      const expired = 'kv.expires_at IS NOT NULL AND kv.expires_at <= ?';
      const rows = await raw(
        'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET ' +
          `value = CASE WHEN ${expired} THEN excluded.value ELSE CAST(CAST(kv.value AS INTEGER) + CAST(? AS INTEGER) AS TEXT) END, ` +
          `expires_at = CASE WHEN ${expired} THEN excluded.expires_at ELSE kv.expires_at END ` +
          `WHERE (CASE WHEN ${expired} THEN CAST(? AS INTEGER) ELSE CAST(kv.value AS INTEGER) + CAST(? AS INTEGER) END) <= ? RETURNING value`,
        [key, String(by), expiresAt, t, by, t, t, by, by, max],
      );
      return rows[0] === undefined ? null : Number(rows[0][0]);
    },
    async list(prefix, options = {}) {
      checkPrefix(prefix);
      const limit = clampLimit(options.limit, 100, 1_000);
      const rows = await raw(
        `SELECT key FROM kv WHERE substr(key, 1, ?) = ? AND key > ? AND ${LIVE} ORDER BY key LIMIT ?`,
        [prefix.length, prefix, options.after ?? '', now(), limit],
      );
      return rows.map((r) => r[0] as string);
    },
    async deletePrefix(prefix) {
      checkPrefix(prefix);
      if (prefix === '') throw new InvalidInputError('kv.deletePrefix needs a non-empty prefix.');
      const rows = await raw('DELETE FROM kv WHERE substr(key, 1, ?) = ? RETURNING key', [
        prefix.length,
        prefix,
      ]);
      return rows.length;
    },
    async purgeExpired(limit) {
      const n = clampLimit(limit, 1_000, 10_000);
      const rows = await raw(
        'DELETE FROM kv WHERE key IN (SELECT key FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT ?) ' +
          'RETURNING key',
        [now(), n],
      );
      return rows.length;
    },
  };

  return Object.freeze({
    readOnly: false,
    users,
    instances,
    credentials,
    workspaces,
    grants,
    accessTokens,
    audit,
    settings,
    kv,
    close: () => driver.close(),
  });
}

/** Migrates (ADR-0006: on open) and returns the storage. */
export async function openSqlStorage(driver: SqlDriver, options: SqlStorageOptions = {}): Promise<Storage> {
  await migrate(driver, options.now ? { now: options.now } : {});
  return createSqlStorage(driver, options);
}
