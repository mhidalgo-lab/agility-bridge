// SPDX-License-Identifier: Apache-2.0
import { createMemoryStorage } from '../src/index.ts';
import { storageContract } from './contract.ts';

storageContract('memory', async (clock) => createMemoryStorage({ now: clock.now }));
