// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync } from 'node:sqlite';
import { openSqlStorage } from '@agility-bridge/storage';
import { countingDriver, quotaStatementContract, storageContract } from '../../storage/test/contract.ts';
import { createSqliteDriver } from '../src/index.ts';

storageContract('sqlite (:memory:)', (clock) =>
  openSqlStorage(createSqliteDriver(new DatabaseSync(':memory:')), { now: clock.now }),
);

quotaStatementContract('sqlite (:memory:)', async (clock) => {
  const counting = countingDriver(createSqliteDriver(new DatabaseSync(':memory:')));
  const storage = await openSqlStorage(counting.driver, { now: clock.now });
  return { storage, statements: counting.statements, reset: counting.reset };
});
