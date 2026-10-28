// SPDX-License-Identifier: Apache-2.0
// Drizzle schema (SQLite dialect) shared by node:sqlite and D1 (ADR-0006). The DDL itself lives in the migrations
// (`src/migrations/`): STRICT tables, CHECK constraints and triggers that Drizzle cannot express. A test compares both.
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  AuditKind,
  AuditStatus,
  CredentialSource,
  JsonObject,
  Role,
  ValidationStatus,
} from './types.ts';

const createdAt = () => integer('created_at').notNull();
const updatedAt = () => integer('updated_at').notNull();

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    displayName: text('display_name'),
    idp: text('idp'),
    idpSubject: text('idp_subject'),
    role: text('role').$type<Role>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    disabledAt: integer('disabled_at'),
  },
  (t) => [uniqueIndex('users_identity').on(t.idp, t.idpSubject)],
);

export const instances = sqliteTable('instances', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  baseUrl: text('base_url').notNull().unique(),
  tls: text('tls', { mode: 'json' }).$type<JsonObject>(),
  numberPrefixes: text('number_prefixes', { mode: 'json' }).$type<JsonObject>(),
  metaFingerprint: text('meta_fingerprint'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  disabledAt: integer('disabled_at'),
});

export const credentials = sqliteTable(
  'credentials',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'restrict' }),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'restrict' }),
    label: text('label').notNull(),
    tokenCiphertext: text('token_ciphertext').notNull(),
    tokenIv: text('token_iv').notNull(),
    keyVersion: integer('key_version').notNull(),
    tokenHint: text('token_hint').notNull(),
    validationStatus: text('validation_status').$type<ValidationStatus>().notNull(),
    validationErrorCode: text('validation_error_code'),
    validatedAt: integer('validated_at'),
    memberOid: text('member_oid'),
    memberName: text('member_name'),
    memberUsername: text('member_username'),
    reachableScopeIds: text('reachable_scope_ids', { mode: 'json' }).$type<string[]>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [index('credentials_instance').on(t.instanceId), index('credentials_owner').on(t.ownerUserId)],
);

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'restrict' }),
    allowedScopeIds: text('allowed_scope_ids', { mode: 'json' }).$type<string[]>().notNull(),
    includeChildScopes: integer('include_child_scopes', { mode: 'boolean' }).notNull(),
    assetTypes: text('asset_types', { mode: 'json' }).$type<JsonObject>(),
    enabledTools: text('enabled_tools', { mode: 'json' }).$type<string[]>(),
    limits: text('limits', { mode: 'json' }).$type<JsonObject>().notNull(),
    defaultCredentialId: text('default_credential_id').references(() => credentials.id, {
      onDelete: 'restrict',
    }),
    writePolicy: text('write_policy', { mode: 'json' }).$type<JsonObject>().notNull(),
    credentialSource: text('credential_source').$type<CredentialSource>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    disabledAt: integer('disabled_at'),
  },
  (t) => [
    index('workspaces_instance').on(t.instanceId),
    index('workspaces_default_credential').on(t.defaultCredentialId),
  ],
);

export const grants = sqliteTable(
  'grants',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'restrict' }),
    label: text('label'),
    credentialId: text('credential_id').references(() => credentials.id, { onDelete: 'restrict' }),
    tools: text('tools', { mode: 'json' }).$type<string[]>(),
    scopeIds: text('scope_ids', { mode: 'json' }).$type<string[]>(),
    assetTypes: text('asset_types', { mode: 'json' }).$type<JsonObject>(),
    limits: text('limits', { mode: 'json' }).$type<JsonObject>().notNull(),
    rateLimit: text('rate_limit', { mode: 'json' }).$type<JsonObject>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    expiresAt: integer('expires_at'),
    revokedAt: integer('revoked_at'),
  },
  (t) => [
    index('grants_workspace').on(t.workspaceId),
    index('grants_user').on(t.userId),
    index('grants_credential').on(t.credentialId),
  ],
);

export const accessTokens = sqliteTable(
  'access_tokens',
  {
    id: text('id').primaryKey(),
    grantId: text('grant_id')
      .notNull()
      .references(() => grants.id, { onDelete: 'cascade' }),
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    label: text('label').notNull(),
    createdAt: createdAt(),
    expiresAt: integer('expires_at'),
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at'),
  },
  (t) => [index('access_tokens_grant').on(t.grantId), index('access_tokens_created').on(t.createdAt, t.id)],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    ts: integer('ts').notNull(),
    kind: text('kind').$type<AuditKind>().notNull(),
    action: text('action').notNull(),
    status: text('status').$type<AuditStatus>().notNull(),
    requestId: text('request_id'),
    userId: text('user_id'),
    grantId: text('grant_id'),
    tokenId: text('token_id'),
    clientId: text('client_id'),
    workspaceId: text('workspace_id'),
    instanceId: text('instance_id'),
    assetNumbers: text('asset_numbers', { mode: 'json' }).$type<string[]>(),
    query: text('query'),
    durationMs: integer('duration_ms'),
    agilityRequests: integer('agility_requests'),
    errorCode: text('error_code'),
    targetType: text('target_type'),
    targetId: text('target_id'),
    details: text('details', { mode: 'json' }).$type<JsonObject>(),
  },
  (t) => [index('audit_log_ts').on(t.ts, t.id), index('audit_log_workspace').on(t.workspaceId, t.ts, t.id)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: updatedAt(),
});

export const kv = sqliteTable(
  'kv',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at'),
  },
  (t) => [index('kv_expires').on(t.expiresAt)],
);

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: integer('version').primaryKey(),
  name: text('name').notNull(),
  checksum: text('checksum').notNull(),
  appliedAt: integer('applied_at').notNull(),
});

export const TABLES = {
  users,
  instances,
  credentials,
  workspaces,
  grants,
  access_tokens: accessTokens,
  audit_log: auditLog,
  settings,
  kv,
  schema_migrations: schemaMigrations,
} as const;
