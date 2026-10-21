// SPDX-License-Identifier: Apache-2.0
// Repository error semantics (docs/dev/storage.md): a missing row on read is `null`, never an error.

export type StorageErrorCode = 'not_found' | 'conflict' | 'invalid_input' | 'read_only' | 'migration';

/** Base class of every error the storage layer throws on purpose. Messages name tables and columns, never values. */
export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageError';
    this.code = code;
  }
}

/** An update or delete named a row that does not exist. */
export class NotFoundError extends StorageError {
  constructor(message: string) {
    super('not_found', message);
    this.name = 'NotFoundError';
  }
}

/** A uniqueness rule, or a row that other rows still reference (delete restrictions, ARCHITECTURE §4). */
export class ConflictError extends StorageError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('conflict', message, options);
    this.name = 'ConflictError';
  }
}

/** A value or a cross-row rule is violated (bad shape, a credential of another instance, a missing parent, …). */
export class InvalidInputError extends StorageError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('invalid_input', message, options);
    this.name = 'InvalidInputError';
  }
}

/** A write reached a read-only adapter. */
export class ReadOnlyStorageError extends StorageError {
  constructor(message = 'This storage is read-only.') {
    super('read_only', message);
    this.name = 'ReadOnlyStorageError';
  }
}

/** The database cannot be used by this binary: it is newer, or a released migration was changed. */
export class MigrationError extends StorageError {
  constructor(message: string) {
    super('migration', message);
    this.name = 'MigrationError';
  }
}
