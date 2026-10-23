// SPDX-License-Identifier: Apache-2.0
// Storage interface, Drizzle schema and migrations (ARCHITECTURE §4, ADR-0006, docs/dev/storage.md).
export {
  ConflictError,
  InvalidInputError,
  MigrationError,
  NotFoundError,
  ReadOnlyStorageError,
  StorageError,
  type StorageErrorCode,
} from './errors.ts';
export { STATS_SCAN_CAP } from './fields.ts';
export { createMemoryStorage, type MemoryStorageOptions } from './memory.ts';
export { MIGRATIONS, type Migration } from './migrations/index.ts';
export { readOnlyStorage } from './read-only.ts';
export * as schema from './schema.ts';
export { createD1Driver, type D1Database, type D1PreparedStatement } from './sql/d1.ts';
export {
  classifySqlError,
  mapSqlError,
  type SqlDriver,
  type SqlFailure,
  type SqlMethod,
  type SqlResult,
  type SqlStatement,
} from './sql/driver.ts';
export {
  type AppliedMigration,
  appliedMigrations,
  type MigrateOptions,
  migrate,
  migrationChecksum,
} from './sql/migrate.ts';
export { createSqlStorage, openSqlStorage, type SqlStorageOptions } from './sql/storage.ts';
export type * from './types.ts';
