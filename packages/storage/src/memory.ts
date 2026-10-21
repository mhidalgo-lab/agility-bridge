// SPDX-License-Identifier: Apache-2.0
// In-memory Storage for tests and single-process hosts. It mirrors the SQL schema's rules (uniques, foreign keys,
// cascades, restrictions, triggers) and passes the same contract suite. Every operation runs without an `await`
// between its read and its write, so each one is atomic like a single SQL statement.
import { ConflictError, InvalidInputError, NotFoundError } from './errors.ts';
import {
  checkId,
  checkRow,
  checkSealedToken,
  checkSettingValue,
  clampLimit,
  prepareCreate,
  preparePatch,
  type TableName,
} from './fields.ts';
import { checkIncrement, checkKey, checkKvValue, checkPrefix, isLive } from './kv-rules.ts';
import type {
  AccessToken,
  AccessTokenRepository,
  AuditEntry,
  AuditRepository,
  Credential,
  CredentialRepository,
  Grant,
  GrantRepository,
  Instance,
  InstanceRepository,
  JsonValue,
  KvStore,
  Now,
  Setting,
  SettingsRepository,
  Storage,
  User,
  UserRepository,
  Workspace,
  WorkspaceRepository,
} from './types.ts';

export interface MemoryStorageOptions {
  now?: Now;
}

type Row = { id: string; createdAt: number } & Record<string, unknown>;

const clone = <T>(value: T): T => structuredClone(value);

function sorted<T extends Row>(rows: Iterable<T>): T[] {
  return [...rows].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function createMemoryStorage(options: MemoryStorageOptions = {}): Storage {
  const now = options.now ?? Date.now;
  const tables = {
    users: new Map<string, User & Row>(),
    instances: new Map<string, Instance & Row>(),
    credentials: new Map<string, Credential & Row>(),
    workspaces: new Map<string, Workspace & Row>(),
    grants: new Map<string, Grant & Row>(),
    access_tokens: new Map<string, AccessToken & Row>(),
  };
  type IdTable = keyof typeof tables;
  const audit: AuditEntry[] = [];
  const settings = new Map<string, { value: string; updatedAt: number }>();
  const kvData = new Map<string, { value: string; expiresAt: number | null }>();

  const conflict = (table: string, what: string) =>
    new ConflictError(`A ${table} row with the same ${what} exists.`);
  const missingParent = (table: string) =>
    new InvalidInputError(`A row that ${table} refers to does not exist.`);

  /** UNIQUE constraints, excluding the row itself on update. */
  function checkUnique(table: IdTable, row: Row): void {
    const others = [...tables[table].values()].filter((r) => r.id !== row.id);
    const clash = (column: string) => row[column] !== null && others.some((r) => r[column] === row[column]);
    if (table === 'users') {
      if (clash('email')) throw conflict(table, 'email');
      if (
        row['idp'] !== null &&
        others.some((r) => r.idp === row['idp'] && r.idpSubject === row['idpSubject'])
      ) {
        throw conflict(table, 'identity');
      }
    }
    if (table === 'instances' && clash('baseUrl')) throw conflict(table, 'base URL');
    if (table === 'workspaces' && clash('slug')) throw conflict(table, 'slug');
    if (table === 'access_tokens' && clash('tokenHash')) throw conflict(table, 'token hash');
  }

  /** The foreign keys and the cross-row triggers of migration 0001, for the columns being written. */
  function checkReferences(table: IdTable, row: Row, written: ReadonlySet<string>): void {
    const has = (t: IdTable, id: unknown) => id === null || (typeof id === 'string' && tables[t].has(id));
    if (table === 'credentials') {
      if (!has('instances', row['instanceId']) || !has('users', row['ownerUserId']))
        throw missingParent(table);
    }
    if (table === 'workspaces') {
      const ws = row as unknown as Workspace;
      if (written.has('defaultCredentialId') && ws.defaultCredentialId !== null) {
        const c = tables.credentials.get(ws.defaultCredentialId);
        if (c === undefined || c.ownerUserId !== null || c.instanceId !== ws.instanceId) {
          throw new InvalidInputError(
            'workspaces.default_credential_id must be a shared credential of the workspace instance.',
          );
        }
      }
      if (!has('instances', ws.instanceId)) throw missingParent(table);
    }
    if (table === 'grants') {
      const g = row as unknown as Grant;
      if (written.has('credentialId') && g.credentialId !== null) {
        const c = tables.credentials.get(g.credentialId);
        const w = tables.workspaces.get(g.workspaceId);
        if (
          c === undefined ||
          w === undefined ||
          c.instanceId !== w.instanceId ||
          (c.ownerUserId !== null && c.ownerUserId !== g.userId)
        ) {
          throw new InvalidInputError(
            "grants.credential_id must be a shared credential or the grant user's own, of the workspace instance.",
          );
        }
      }
      if (!has('workspaces', g.workspaceId) || !has('users', g.userId)) throw missingParent(table);
    }
    if (table === 'access_tokens' && !has('grants', row['grantId'])) throw missingParent(table);
  }

  /** Delete restrictions, or the rows a delete cascades to. */
  function deleteRow(table: IdTable, id: string): void {
    const refs = (t: IdTable, column: string) => [...tables[t].values()].some((r) => r[column] === id);
    const stillReferenced =
      (table === 'users' && (refs('credentials', 'ownerUserId') || refs('grants', 'userId'))) ||
      (table === 'instances' && (refs('credentials', 'instanceId') || refs('workspaces', 'instanceId'))) ||
      (table === 'credentials' &&
        (refs('grants', 'credentialId') || refs('workspaces', 'defaultCredentialId')));
    if (stillReferenced)
      throw new ConflictError(`The ${table} row is still referenced; revoke or disable it instead.`);
    if (table === 'workspaces') {
      for (const g of [...tables.grants.values()]) if (g.workspaceId === id) deleteRow('grants', g.id);
    }
    if (table === 'grants') {
      for (const t of [...tables.access_tokens.values()])
        if (t.grantId === id) tables.access_tokens.delete(t.id);
    }
    tables[table].delete(id);
  }

  function repository<T>(table: IdTable) {
    const map = tables[table] as Map<string, Row>;
    const name = table as TableName;
    return {
      async get(id: string): Promise<T | null> {
        const row = typeof id === 'string' ? map.get(id) : undefined;
        return row === undefined ? null : (clone(row) as unknown as T);
      },
      async create(input: object): Promise<T> {
        const row = prepareCreate<Row>(name, input, now());
        if (map.has(row.id)) throw conflict(table, 'id');
        checkUnique(table, row);
        checkReferences(table, row, new Set(Object.keys(row)));
        map.set(row.id, row);
        return clone(row) as unknown as T;
      },
      async update(id: string, patch: object): Promise<T> {
        checkId(name, id);
        const values = preparePatch<Record<string, unknown>>(name, patch);
        const current = map.get(id);
        if (current === undefined) throw new NotFoundError(`No ${table} row with this id.`);
        if ('updatedAt' in current) values['updatedAt'] = now();
        const next = { ...current, ...values } as Row;
        checkRow(name, next);
        checkUnique(table, next);
        checkReferences(table, next, new Set(Object.keys(values)));
        if (table === 'instances') {
          const changed =
            next['baseUrl'] !== current['baseUrl'] ||
            JSON.stringify(next['tls']) !== JSON.stringify(current['tls']);
          if (
            changed &&
            [...tables.credentials.values()].some((c) => c.instanceId === id && c.revokedAt === null)
          ) {
            throw new ConflictError(
              'instances.base_url and tls cannot change while the instance has credentials that are not revoked.',
            );
          }
        }
        map.set(id, next);
        return clone(next) as unknown as T;
      },
      async delete(id: string): Promise<void> {
        checkId(name, id);
        if (!map.has(id)) throw new NotFoundError(`No ${table} row with this id.`);
        deleteRow(table, id);
      },
      list(filter: (row: T) => boolean = () => true): Promise<T[]> {
        return Promise.resolve(
          sorted(map.values())
            .map((r) => clone(r) as unknown as T)
            .filter(filter),
        );
      },
    };
  }

  const userRepo = repository<User>('users');
  const users: UserRepository = {
    ...userRepo,
    async getByEmail(email) {
      if (typeof email !== 'string') return null;
      const lower = email.toLowerCase();
      const row = [...tables.users.values()].find((u) => u.email === lower);
      return row === undefined ? null : clone(row);
    },
    async getByIdentity(idp, idpSubject) {
      const row = [...tables.users.values()].find((u) => u.idp === idp && u.idpSubject === idpSubject);
      return row === undefined ? null : clone(row);
    },
    list: () => userRepo.list(),
  };

  const instanceRepo = repository<Instance>('instances');
  const instances: InstanceRepository = { ...instanceRepo, list: () => instanceRepo.list() };

  const credentialRepo = repository<Credential>('credentials');
  const credentials: CredentialRepository = {
    ...credentialRepo,
    list: (f = {}) =>
      credentialRepo.list(
        (c) =>
          (f.instanceId === undefined || c.instanceId === f.instanceId) &&
          (f.ownerUserId === undefined || c.ownerUserId === f.ownerUserId) &&
          (f.keyVersion === undefined || c.keyVersion === f.keyVersion),
      ),
    async replaceSecret(id, expected, next) {
      checkId('credentials', id);
      checkSealedToken(expected);
      checkSealedToken(next);
      const row = tables.credentials.get(id);
      if (
        row === undefined ||
        row.keyVersion !== expected.keyVersion ||
        row.tokenCiphertext !== expected.tokenCiphertext ||
        row.tokenIv !== expected.tokenIv
      ) {
        return false;
      }
      row.tokenCiphertext = next.tokenCiphertext;
      row.tokenIv = next.tokenIv;
      row.keyVersion = next.keyVersion;
      return true;
    },
  };

  const workspaceRepo = repository<Workspace>('workspaces');
  const workspaces: WorkspaceRepository = {
    ...workspaceRepo,
    async getBySlug(slug) {
      const row = [...tables.workspaces.values()].find((w) => w.slug === slug);
      return row === undefined ? null : clone(row);
    },
    list: (f = {}) => workspaceRepo.list((w) => f.instanceId === undefined || w.instanceId === f.instanceId),
  };

  const grantRepo = repository<Grant>('grants');
  const grants: GrantRepository = {
    ...grantRepo,
    list: (f = {}) =>
      grantRepo.list(
        (g) =>
          (f.workspaceId === undefined || g.workspaceId === f.workspaceId) &&
          (f.userId === undefined || g.userId === f.userId) &&
          (f.credentialId === undefined || g.credentialId === f.credentialId),
      ),
  };

  const tokenRepo = repository<AccessToken>('access_tokens');
  const accessTokens: AccessTokenRepository = {
    ...tokenRepo,
    async getByHash(tokenHash) {
      const row = [...tables.access_tokens.values()].find((t) => t.tokenHash === tokenHash);
      return row === undefined ? null : clone(row);
    },
    list: (f = {}) => tokenRepo.list((t) => f.grantId === undefined || t.grantId === f.grantId),
    async touch(id, minIntervalMs) {
      checkId('access_tokens', id);
      if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0) {
        throw new InvalidInputError('minIntervalMs must be an integer ≥ 0.');
      }
      const row = tables.access_tokens.get(id);
      const t = now();
      if (row === undefined || (row.lastUsedAt !== null && row.lastUsedAt > t - minIntervalMs)) return false;
      row.lastUsedAt = t;
      return true;
    },
  };

  const byNewest = (a: AuditEntry, b: AuditEntry) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const auditRepo: AuditRepository = {
    async append(entry) {
      const row = prepareCreate<AuditEntry>('audit_log', entry, now());
      if (audit.some((a) => a.id === row.id)) throw conflict('audit_log', 'id');
      audit.push(row);
    },
    async query(q = {}) {
      const limit = clampLimit(q.limit, 100, 1_000);
      return audit
        .filter(
          (a) =>
            (q.workspaceId === undefined || a.workspaceId === q.workspaceId) &&
            (q.userId === undefined || a.userId === q.userId) &&
            (q.kind === undefined || a.kind === q.kind) &&
            (q.status === undefined || a.status === q.status) &&
            (q.from === undefined || a.ts >= q.from) &&
            (q.to === undefined || a.ts < q.to) &&
            (q.after === undefined || a.ts < q.after.ts || (a.ts === q.after.ts && a.id < q.after.id)),
        )
        .sort(byNewest)
        .slice(0, limit)
        .map(clone);
    },
    async purge(before, limit) {
      const n = clampLimit(limit, 1_000, 10_000);
      const victims = new Set(
        audit
          .filter((a) => a.ts < before)
          .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
          .slice(0, n),
      );
      for (let i = audit.length - 1; i >= 0; i--) if (victims.has(audit[i] as AuditEntry)) audit.splice(i, 1);
      return victims.size;
    },
  };

  const toSetting = (key: string, row: { value: string; updatedAt: number }): Setting => ({
    key,
    value: JSON.parse(row.value) as JsonValue,
    updatedAt: row.updatedAt,
  });
  const settingsRepo: SettingsRepository = {
    async get(key) {
      const row = settings.get(key);
      return row === undefined ? null : toSetting(key, row);
    },
    async set(key, value) {
      checkSettingValue(key, value);
      const row = { value: JSON.stringify(value), updatedAt: now() };
      settings.set(key, row);
      return toSetting(key, row);
    },
    async delete(key) {
      return settings.delete(key);
    },
    async list() {
      return [...settings.keys()]
        .sort()
        .map((k) => toSetting(k, settings.get(k) as { value: string; updatedAt: number }));
    },
  };

  const live = (key: string): { value: string; expiresAt: number | null } | undefined => {
    const entry = kvData.get(key);
    return entry !== undefined && isLive(entry.expiresAt, now()) ? entry : undefined;
  };
  const kv: KvStore = {
    async get(key) {
      checkKey(key);
      return live(key)?.value ?? null;
    },
    async set(key, value, options = {}) {
      const expiresAt = checkKvValue(key, value, options);
      kvData.set(key, { value, expiresAt });
    },
    async setIfAbsent(key, value, options = {}) {
      const expiresAt = checkKvValue(key, value, options);
      if (live(key) !== undefined) return false;
      kvData.set(key, { value, expiresAt });
      return true;
    },
    async take(key) {
      checkKey(key);
      const entry = live(key);
      kvData.delete(key);
      return entry?.value ?? null;
    },
    async delete(key) {
      checkKey(key);
      const entry = live(key);
      kvData.delete(key);
      return entry !== undefined;
    },
    async increment(key, options = {}) {
      const { by, max, expiresAt } = checkIncrement(key, options);
      if (by > max) return null;
      const entry = kvData.get(key);
      if (entry === undefined || !isLive(entry.expiresAt, now())) {
        kvData.set(key, { value: String(by), expiresAt });
        return by;
      }
      const next = (Number.parseInt(entry.value, 10) || 0) + by;
      if (next > max) return null;
      entry.value = String(next);
      return next;
    },
    async list(prefix, options = {}) {
      checkPrefix(prefix);
      const limit = clampLimit(options.limit, 100, 1_000);
      const after = options.after ?? '';
      return [...kvData.keys()]
        .filter((k) => k.startsWith(prefix) && k > after && live(k) !== undefined)
        .sort()
        .slice(0, limit);
    },
    async purgeExpired(limit) {
      const n = clampLimit(limit, 1_000, 10_000);
      let count = 0;
      for (const [k, entry] of kvData) {
        if (count >= n) break;
        if (!isLive(entry.expiresAt, now())) {
          kvData.delete(k);
          count++;
        }
      }
      return count;
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
    audit: auditRepo,
    settings: settingsRepo,
    kv,
    close: async () => {},
  });
}
