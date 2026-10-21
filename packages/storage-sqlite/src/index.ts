// SPDX-License-Identifier: Apache-2.0
// node:sqlite adapter for the Storage interface (ADR-0006). Source-only, bundled into the CLI.
export { createSqliteDriver } from './driver.ts';
export { copyPrivateFile, ensurePrivateDir, openPrivateFile, UnsafeFileError } from './files.ts';
export {
  openSqliteStorage,
  restoreSqliteBackup,
  type SqliteStorage,
  type SqliteStorageOptions,
} from './open.ts';
