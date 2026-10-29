// SPDX-License-Identifier: Apache-2.0
// The write limiter over the shared `kv` counters of SQLite (P7-03): same suite as memory and D1.
import { DatabaseSync } from 'node:sqlite';
import { openSqlStorage } from '@agility-bridge/storage';
import { createSqliteDriver } from '@agility-bridge/storage-sqlite';
import { writeLimiterContract } from '../../../packages/core/test/helpers/write-limiter-contract.ts';

writeLimiterContract('storage kv (SQLite)', async () => {
  let t = 1_760_000_000_000;
  const storage = await openSqlStorage(createSqliteDriver(new DatabaseSync(':memory:')), { now: () => t });
  return {
    counters: storage.kv,
    advance: (ms) => {
      t += ms;
    },
    now: () => t,
  };
});
