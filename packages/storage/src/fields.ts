// SPDX-License-Identifier: Apache-2.0
// Column rules shared by every adapter: the same input is accepted or refused, and defaulted, identically on memory,
// SQLite and D1. The SQL schema repeats the essential checks as constraints (defence in depth); cross-row rules live
// in the adapters (triggers in SQL).
import { InvalidInputError } from './errors.ts';

type Kind =
  | 'id'
  | 'text'
  | 'label'
  | 'email'
  | 'url'
  | 'slug'
  | 'hash'
  | 'prefix'
  | 'hint'
  | 'role'
  | 'validation'
  | 'credentialSource'
  | 'auditKind'
  | 'auditStatus'
  | 'time'
  | 'count'
  | 'version'
  | 'bool'
  | 'object'
  | 'strings';

interface Field {
  readonly kind: Kind;
  /** Must be given on create. */
  readonly required?: boolean;
  /** Accepts `null` (and defaults to it on create unless `fallback` is set). */
  readonly nullable?: boolean;
  /** Value on create when omitted. */
  readonly fallback?: unknown;
  /** May change after create. */
  readonly patch?: boolean;
}

export type TableName =
  | 'users'
  | 'instances'
  | 'credentials'
  | 'workspaces'
  | 'grants'
  | 'access_tokens'
  | 'audit_log';

const req = (kind: Kind, patch = false): Field => ({ kind, required: true, patch });
const opt = (kind: Kind, patch = true): Field => ({ kind, nullable: true, patch });
const def = (kind: Kind, fallback: unknown, patch = true): Field => ({ kind, fallback, patch });
const stamp: Field = { kind: 'time' };

export const FIELDS: Readonly<Record<TableName, Readonly<Record<string, Field>>>> = {
  users: {
    id: req('id'),
    email: req('email', true),
    displayName: opt('label'),
    idp: opt('label'),
    idpSubject: opt('text'),
    role: req('role', true),
    createdAt: stamp,
    updatedAt: stamp,
    disabledAt: opt('time'),
  },
  instances: {
    id: req('id'),
    label: req('label', true),
    baseUrl: req('url', true),
    tls: opt('object'),
    numberPrefixes: opt('object'),
    metaFingerprint: opt('text'),
    createdAt: stamp,
    updatedAt: stamp,
    disabledAt: opt('time'),
  },
  credentials: {
    id: req('id'),
    instanceId: req('id'),
    ownerUserId: opt('id', false),
    label: req('label', true),
    tokenCiphertext: req('text'),
    tokenIv: req('text'),
    keyVersion: req('version'),
    tokenHint: req('hint', true),
    validationStatus: def('validation', 'unvalidated'),
    validationErrorCode: opt('label'),
    validatedAt: opt('time'),
    memberOid: opt('label'),
    memberName: opt('label'),
    memberUsername: opt('label'),
    reachableScopeIds: opt('strings'),
    createdAt: stamp,
    updatedAt: stamp,
    revokedAt: opt('time'),
  },
  workspaces: {
    id: req('id'),
    slug: req('slug', true),
    name: req('label', true),
    instanceId: req('id'),
    allowedScopeIds: def('strings', []),
    includeChildScopes: def('bool', false),
    assetTypes: opt('object'),
    enabledTools: opt('strings'),
    limits: def('object', {}),
    defaultCredentialId: opt('id'),
    writePolicy: def('object', {}),
    credentialSource: def('credentialSource', 'stored'),
    createdAt: stamp,
    updatedAt: stamp,
    disabledAt: opt('time'),
  },
  grants: {
    id: req('id'),
    workspaceId: req('id'),
    userId: opt('id', false),
    label: opt('label'),
    credentialId: opt('id'),
    tools: opt('strings'),
    scopeIds: opt('strings'),
    assetTypes: opt('object'),
    limits: def('object', {}),
    rateLimit: opt('object'),
    createdAt: stamp,
    updatedAt: stamp,
    expiresAt: opt('time'),
    revokedAt: opt('time'),
  },
  access_tokens: {
    id: req('id'),
    grantId: req('id'),
    prefix: req('prefix'),
    tokenHash: req('hash'),
    label: req('label', true),
    createdAt: stamp,
    expiresAt: opt('time'),
    lastUsedAt: opt('time', false),
    revokedAt: opt('time'),
  },
  audit_log: {
    id: req('id'),
    ts: req('time'),
    kind: req('auditKind'),
    action: req('label'),
    status: req('auditStatus'),
    requestId: opt('label'),
    userId: opt('label'),
    grantId: opt('label'),
    tokenId: opt('label'),
    clientId: opt('label'),
    workspaceId: opt('label'),
    instanceId: opt('label'),
    assetNumbers: opt('strings'),
    query: opt('text'),
    durationMs: opt('count'),
    agilityRequests: opt('count'),
    errorCode: opt('label'),
    targetType: opt('label'),
    targetId: opt('label'),
    details: opt('object'),
  },
};

export const LIMITS = Object.freeze({
  id: 128,
  label: 200,
  text: 8_192,
  email: 320,
  url: 2_048,
  listItems: 1_000,
  listItem: 256,
  jsonBytes: 65_536,
});

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HASH = /^[0-9a-f]{64}$/;
const PREFIX = /^ab_(?:live|test)_[0-9A-Za-z]{4}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const CONTROL = /[\u0000-\u001f\u007f]/;

function bad(table: string, column: string, why: string): InvalidInputError {
  return new InvalidInputError(`${table}.${column} ${why}.`);
}

function checkText(table: string, column: string, value: unknown, max: number, controlsOk = false): void {
  if (typeof value !== 'string' || value.length === 0) throw bad(table, column, 'must be a non-empty string');
  if (value.length > max) throw bad(table, column, `must be at most ${max} characters`);
  if (!controlsOk && CONTROL.test(value)) throw bad(table, column, 'must not contain control characters');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkValue(table: TableName, column: string, field: Field, value: unknown): void {
  if (value === null) {
    if (field.nullable) return;
    throw bad(table, column, 'must not be null');
  }
  switch (field.kind) {
    case 'id':
      checkText(table, column, value, LIMITS.id);
      return;
    case 'label':
      checkText(table, column, value, LIMITS.label);
      return;
    case 'text':
      checkText(table, column, value, LIMITS.text, true);
      return;
    case 'email':
      checkText(table, column, value, LIMITS.email);
      if ((value as string).toLowerCase() !== value || !(value as string).includes('@')) {
        throw bad(table, column, 'must be a lower-case email address');
      }
      return;
    case 'url':
      checkText(table, column, value, LIMITS.url);
      if (!/^https?:\/\/[^\s]+$/.test(value as string)) throw bad(table, column, 'must be an http(s) URL');
      return;
    case 'slug':
      if (typeof value !== 'string' || !SLUG.test(value)) {
        throw bad(table, column, 'must be 1-63 lower-case letters, digits or inner hyphens');
      }
      return;
    case 'hash':
      if (typeof value !== 'string' || !HASH.test(value))
        throw bad(table, column, 'must be 64 lower-case hex digits');
      return;
    case 'prefix':
      if (typeof value !== 'string' || !PREFIX.test(value))
        throw bad(table, column, 'must be ab_live_ or ab_test_ and 4 letters or digits');
      return;
    case 'hint':
      if (typeof value !== 'string' || value.length > 4 || CONTROL.test(value)) {
        throw bad(table, column, 'must be at most 4 characters');
      }
      return;
    case 'role':
      if (value !== 'owner' && value !== 'admin' && value !== 'member') {
        throw bad(table, column, 'must be owner, admin or member');
      }
      return;
    case 'validation':
      if (value !== 'unvalidated' && value !== 'valid' && value !== 'invalid') {
        throw bad(table, column, 'must be unvalidated, valid or invalid');
      }
      return;
    case 'credentialSource':
      if (value !== 'stored' && value !== 'passthrough')
        throw bad(table, column, 'must be stored or passthrough');
      return;
    case 'auditKind':
      if (value !== 'tool_call' && value !== 'write' && value !== 'auth' && value !== 'admin') {
        throw bad(table, column, 'must be tool_call, write, auth or admin');
      }
      return;
    case 'auditStatus':
      if (value !== 'ok' && value !== 'error' && value !== 'denied')
        throw bad(table, column, 'must be ok, error or denied');
      return;
    case 'time':
    case 'count':
      if (!Number.isSafeInteger(value) || (value as number) < 0)
        throw bad(table, column, 'must be an integer ≥ 0');
      return;
    case 'version':
      if (!Number.isSafeInteger(value) || (value as number) < 1)
        throw bad(table, column, 'must be an integer ≥ 1');
      return;
    case 'bool':
      if (typeof value !== 'boolean') throw bad(table, column, 'must be a boolean');
      return;
    case 'object':
      if (!isPlainObject(value)) throw bad(table, column, 'must be a JSON object');
      checkJsonSize(table, column, value);
      return;
    case 'strings':
      if (!Array.isArray(value)) throw bad(table, column, 'must be a list of strings');
      if (value.length > LIMITS.listItems)
        throw bad(table, column, `must have at most ${LIMITS.listItems} entries`);
      for (const item of value) checkText(table, column, item, LIMITS.listItem);
      return;
  }
}

function checkJsonSize(table: string, column: string, value: unknown): void {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    throw bad(table, column, 'must be JSON');
  }
  if (new TextEncoder().encode(text).length > LIMITS.jsonBytes) {
    throw bad(table, column, `must be at most ${LIMITS.jsonBytes} bytes as JSON`);
  }
}

/** A JSON value for `settings` (any shape, bounded). */
export function checkSettingValue(key: string, value: unknown): void {
  checkText('settings', 'key', key, LIMITS.label);
  if (value === undefined) throw new InvalidInputError('settings.value must be JSON.');
  checkJsonSize('settings', 'value', value);
}

function copyJson<T>(value: T): T {
  return value === null || typeof value !== 'object' ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Validates a new record and returns the complete row (defaults filled, JSON deep-copied so callers cannot mutate
 * stored values). `createdAt`/`updatedAt` are set from `now` when the table has them.
 */
export function prepareCreate<T>(table: TableName, input: object, now: number): T {
  const fields = FIELDS[table];
  const source = input as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!(key in fields) || ((key === 'createdAt' || key === 'updatedAt') && source[key] !== undefined)) {
      throw bad(table, key, 'is not accepted');
    }
  }
  const row: Record<string, unknown> = {};
  for (const [column, field] of Object.entries(fields)) {
    if (field === stamp) {
      row[column] = now;
      continue;
    }
    let value = source[column];
    if (value === undefined) {
      if (field.required) throw bad(table, column, 'is required');
      value = field.fallback !== undefined ? field.fallback : null;
    }
    checkValue(table, column, field, value);
    row[column] = copyJson(value);
  }
  checkRow(table, row);
  return row as T;
}

/** Validates a patch: only patchable columns, valid values. Returns a deep copy without `undefined` entries. */
export function preparePatch<P>(table: TableName, patch: object): P {
  const fields = FIELDS[table];
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(patch as Record<string, unknown>)) {
    const field = fields[column];
    if (field === undefined || field.patch !== true) throw bad(table, column, 'cannot be changed');
    if (value === undefined) continue;
    checkValue(table, column, field, value);
    out[column] = copyJson(value);
  }
  return out as P;
}

/** Checks a patched row's cross-column rules (the same ones `prepareCreate` checks). */
export function checkRow(table: TableName, row: Record<string, unknown>): void {
  if (table === 'users' && (row['idp'] === null) !== (row['idpSubject'] === null)) {
    throw bad(table, 'idp', 'and idpSubject must be set together');
  }
  if (table === 'grants' && row['userId'] === null && row['label'] === null) {
    throw bad(table, 'label', 'is required for a service grant');
  }
}

export function checkId(table: TableName, id: unknown): asserts id is string {
  checkText(table, 'id', id, LIMITS.id);
}

export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new InvalidInputError('limit must be a positive integer.');
  return Math.min(limit, max);
}

/** A sealed token handed to `credentials.replaceSecret`. */
export function checkSealedToken(value: unknown): void {
  const v = value as Record<string, unknown> | null;
  if (typeof v !== 'object' || v === null) throw new InvalidInputError('A sealed token is required.');
  const fields = FIELDS.credentials;
  for (const column of ['tokenCiphertext', 'tokenIv', 'keyVersion'] as const) {
    checkValue('credentials', column, fields[column] as Field, v[column]);
  }
}
