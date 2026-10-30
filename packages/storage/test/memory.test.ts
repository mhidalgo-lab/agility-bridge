// SPDX-License-Identifier: Apache-2.0
import { createMemoryStorage } from '../src/index.ts';
import { quotaStatementContract, storageContract } from './contract.ts';

storageContract('memory', async (clock) => createMemoryStorage({ now: clock.now }));

// The memory adapter has no statements: its `kv` calls stand in, so the contract's one-call-per-step shape holds.
quotaStatementContract('memory', async (clock) => {
  const inner = createMemoryStorage({ now: clock.now });
  let n = 0;
  const kv = Object.fromEntries(
    Object.entries(inner.kv).map(([k, f]) => [
      k,
      (...a: unknown[]) => (n++, (f as (...x: unknown[]) => unknown)(...a)),
    ]),
  ) as unknown as typeof inner.kv;
  return {
    storage: { ...inner, kv },
    statements: () => n,
    reset: () => {
      n = 0;
    },
  };
});
