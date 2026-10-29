// SPDX-License-Identifier: Apache-2.0
// The write limiter over the shared `kv` counters of the memory storage (P7-03); SQLite and D1 run the same suite.
import { createMemoryStorage } from '@agility-bridge/storage';
import { writeLimiterContract } from '../../core/test/helpers/write-limiter-contract.ts';

writeLimiterContract('storage kv (memory)', async () => {
  let t = 1_760_000_000_000;
  const storage = createMemoryStorage({ now: () => t });
  return {
    counters: storage.kv,
    advance: (ms) => {
      t += ms;
    },
    now: () => t,
  };
});
