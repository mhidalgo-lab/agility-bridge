// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync } from 'node:sqlite';
import { openSqlStorage } from '@agility-bridge/storage';
import { storageContract } from '../../storage/test/contract.ts';
import { createSqliteDriver } from '../src/index.ts';

storageContract('sqlite (:memory:)', (clock) =>
  openSqlStorage(createSqliteDriver(new DatabaseSync(':memory:')), { now: clock.now }),
);
