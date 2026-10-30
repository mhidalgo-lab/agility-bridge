// SPDX-License-Identifier: Apache-2.0
import { ReadOnlyStorageError } from './errors.ts';
import type { Storage } from './types.ts';

const WRITES: Readonly<Record<string, readonly string[]>> = {
  users: ['create', 'update', 'delete', 'bind', 'unbind'],
  instances: ['create', 'update', 'delete'],
  credentials: ['create', 'update', 'delete', 'replaceSecret', 'recordValidation'],
  workspaces: ['create', 'update', 'delete'],
  grants: ['create', 'update', 'delete'],
  accessTokens: ['create', 'update', 'delete', 'touch'],
  audit: ['append', 'purge'],
  settings: ['set', 'delete'],
  kv: ['set', 'setIfAbsent', 'take', 'delete', 'increment', 'incrementMany', 'purgeExpired', 'deletePrefix'],
};

/** A view of `storage` whose every write throws `ReadOnlyStorageError` (stdio configuration, diagnostics). */
export function readOnlyStorage(storage: Storage): Storage {
  const refuse = async (): Promise<never> => {
    throw new ReadOnlyStorageError();
  };
  const view: Record<string, unknown> = { readOnly: true, close: () => storage.close() };
  for (const [name, writes] of Object.entries(WRITES)) {
    const repo = { ...(storage as unknown as Record<string, Record<string, unknown>>)[name] };
    for (const method of writes) repo[method] = refuse;
    view[name] = Object.freeze(repo);
  }
  return Object.freeze(view) as unknown as Storage;
}
