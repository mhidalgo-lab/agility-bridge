// SPDX-License-Identifier: Apache-2.0
// RELEASED MIGRATIONS NEVER CHANGE: their checksums are recorded in every database (and frozen in
// test/migrations.test.ts). Fix a mistake with a new migration.
import type { Migration } from './types.ts';

const json = (column: string, type: 'array' | 'object', nullable: boolean): string =>
  `CHECK (${nullable ? `${column} IS NULL OR ` : ''}(json_valid(${column}) AND json_type(${column}) = '${type}'))`;

export const migration0001: Migration = {
  version: 1,
  name: 'init',
  statements: [
    `CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND instr(email, '@') > 0),
  display_name TEXT,
  idp TEXT,
  idp_subject TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER,
  CHECK ((idp IS NULL) = (idp_subject IS NULL))
) STRICT`,
    'CREATE UNIQUE INDEX users_identity ON users (idp, idp_subject)',

    `CREATE TABLE instances (
  id TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL UNIQUE CHECK (base_url GLOB 'http://*' OR base_url GLOB 'https://*'),
  tls TEXT ${json('tls', 'object', true)},
  number_prefixes TEXT ${json('number_prefixes', 'object', true)},
  meta_fingerprint TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER
) STRICT`,

    `CREATE TABLE credentials (
  id TEXT PRIMARY KEY NOT NULL,
  instance_id TEXT NOT NULL REFERENCES instances (id) ON DELETE RESTRICT,
  owner_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  label TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  token_hint TEXT NOT NULL CHECK (length(token_hint) <= 4),
  validation_status TEXT NOT NULL CHECK (validation_status IN ('unvalidated', 'valid', 'invalid')),
  validation_error_code TEXT,
  validated_at INTEGER,
  member_oid TEXT,
  member_name TEXT,
  member_username TEXT,
  reachable_scope_ids TEXT ${json('reachable_scope_ids', 'array', true)},
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT`,
    'CREATE INDEX credentials_instance ON credentials (instance_id)',
    'CREATE INDEX credentials_owner ON credentials (owner_user_id)',

    `CREATE TABLE workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 63 AND slug NOT GLOB '*[^a-z0-9-]*'),
  name TEXT NOT NULL,
  instance_id TEXT NOT NULL REFERENCES instances (id) ON DELETE RESTRICT,
  allowed_scope_ids TEXT NOT NULL ${json('allowed_scope_ids', 'array', false)},
  include_child_scopes INTEGER NOT NULL CHECK (include_child_scopes IN (0, 1)),
  asset_types TEXT ${json('asset_types', 'object', true)},
  enabled_tools TEXT ${json('enabled_tools', 'array', true)},
  limits TEXT NOT NULL ${json('limits', 'object', false)},
  default_credential_id TEXT REFERENCES credentials (id) ON DELETE RESTRICT,
  write_policy TEXT NOT NULL ${json('write_policy', 'object', false)},
  credential_source TEXT NOT NULL CHECK (credential_source IN ('stored', 'passthrough')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER
) STRICT`,
    'CREATE INDEX workspaces_instance ON workspaces (instance_id)',
    'CREATE INDEX workspaces_default_credential ON workspaces (default_credential_id)',

    `CREATE TABLE grants (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  label TEXT,
  credential_id TEXT REFERENCES credentials (id) ON DELETE RESTRICT,
  tools TEXT ${json('tools', 'array', true)},
  scope_ids TEXT ${json('scope_ids', 'array', true)},
  asset_types TEXT ${json('asset_types', 'object', true)},
  limits TEXT NOT NULL ${json('limits', 'object', false)},
  rate_limit TEXT ${json('rate_limit', 'object', true)},
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  CHECK (user_id IS NOT NULL OR label IS NOT NULL)
) STRICT`,
    'CREATE INDEX grants_workspace ON grants (workspace_id)',
    'CREATE INDEX grants_user ON grants (user_id)',
    'CREATE INDEX grants_credential ON grants (credential_id)',

    `CREATE TABLE access_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  grant_id TEXT NOT NULL REFERENCES grants (id) ON DELETE CASCADE,
  prefix TEXT NOT NULL CHECK (length(prefix) = 12 AND (prefix GLOB 'ab_live_*' OR prefix GLOB 'ab_test_*') AND substr(prefix, 9) NOT GLOB '*[^0-9A-Za-z]*'),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER
) STRICT`,
    'CREATE INDEX access_tokens_grant ON access_tokens (grant_id)',

    `CREATE TABLE audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tool_call', 'write', 'auth', 'admin')),
  action TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'denied')),
  request_id TEXT,
  user_id TEXT,
  grant_id TEXT,
  token_id TEXT,
  client_id TEXT,
  workspace_id TEXT,
  instance_id TEXT,
  asset_numbers TEXT ${json('asset_numbers', 'array', true)},
  query TEXT,
  duration_ms INTEGER,
  agility_requests INTEGER,
  error_code TEXT,
  target_type TEXT,
  target_id TEXT,
  details TEXT ${json('details', 'object', true)}
) STRICT`,
    'CREATE INDEX audit_log_ts ON audit_log (ts, id)',
    'CREATE INDEX audit_log_workspace ON audit_log (workspace_id, ts, id)',

    `CREATE TABLE settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at INTEGER NOT NULL
) STRICT`,

    `CREATE TABLE kv (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER
) STRICT`,
    'CREATE INDEX kv_expires ON kv (expires_at)',

    // Cross-row rules (ARCHITECTURE §4, ADR-0008). Messages start with `ab_invalid:` or `ab_conflict:`, which the
    // adapters map to InvalidInputError and ConflictError.
    `CREATE TRIGGER workspaces_default_credential_insert BEFORE INSERT ON workspaces
WHEN NEW.default_credential_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM credentials c
  WHERE c.id = NEW.default_credential_id AND c.owner_user_id IS NULL AND c.instance_id = NEW.instance_id)
BEGIN
  SELECT RAISE(ABORT, 'ab_invalid: workspaces.default_credential_id must be a shared credential of the workspace instance');
END`,
    `CREATE TRIGGER workspaces_default_credential_update BEFORE UPDATE OF default_credential_id ON workspaces
WHEN NEW.default_credential_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM credentials c
  WHERE c.id = NEW.default_credential_id AND c.owner_user_id IS NULL AND c.instance_id = NEW.instance_id)
BEGIN
  SELECT RAISE(ABORT, 'ab_invalid: workspaces.default_credential_id must be a shared credential of the workspace instance');
END`,
    `CREATE TRIGGER grants_credential_insert BEFORE INSERT ON grants
WHEN NEW.credential_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM credentials c JOIN workspaces w ON w.id = NEW.workspace_id
  WHERE c.id = NEW.credential_id AND c.instance_id = w.instance_id
    AND (c.owner_user_id IS NULL OR c.owner_user_id = NEW.user_id))
BEGIN
  SELECT RAISE(ABORT, 'ab_invalid: grants.credential_id must be a shared credential or the grant user''s own, of the workspace instance');
END`,
    `CREATE TRIGGER grants_credential_update BEFORE UPDATE OF credential_id ON grants
WHEN NEW.credential_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM credentials c JOIN workspaces w ON w.id = NEW.workspace_id
  WHERE c.id = NEW.credential_id AND c.instance_id = w.instance_id
    AND (c.owner_user_id IS NULL OR c.owner_user_id = NEW.user_id))
BEGIN
  SELECT RAISE(ABORT, 'ab_invalid: grants.credential_id must be a shared credential or the grant user''s own, of the workspace instance');
END`,
    // An instance's origin and TLS trust are immutable while live credentials exist (THREAT_MODEL A14).
    `CREATE TRIGGER instances_origin_update BEFORE UPDATE OF base_url, tls ON instances
WHEN (NEW.base_url IS NOT OLD.base_url OR NEW.tls IS NOT OLD.tls) AND EXISTS (
  SELECT 1 FROM credentials c WHERE c.instance_id = NEW.id AND c.revoked_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'ab_conflict: instances.base_url and tls cannot change while the instance has credentials that are not revoked');
END`,
    // Append-only audit (THREAT_MODEL T17): rows are never updated; retention deletes whole rows.
    `CREATE TRIGGER audit_log_append_only BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'ab_conflict: audit_log rows cannot be changed');
END`,
  ],
};
