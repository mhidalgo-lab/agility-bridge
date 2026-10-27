// SPDX-License-Identifier: Apache-2.0
import {
  closedBreaker,
  createBudget,
  DEFAULT_LIMITS,
  type Logger,
  Secret,
  silentLogger,
  systemClock,
  type ToolContext,
  unboundedLimiter,
  webCryptoRandom,
} from '../../src/index.ts';

/** A complete, synthetic tool context for tests. */
export function makeContext(
  overrides: Partial<ToolContext> = {},
  logger: Logger = silentLogger,
): ToolContext {
  return {
    requestId: crypto.randomUUID(),
    instance: { id: 'env', baseUrl: 'https://agility.example.com/SyntheticInstance' },
    workspace: {
      id: 'default',
      name: 'Default',
      groups: ['core', 'query', 'work', 'planning', 'people', 'portfolio'],
      writes: { enabled: false, approval: 'unavailable' },
    },
    credential: { id: 'cred-1', kind: 'personal', token: new Secret('FAKE-token-1') },
    projects: { allowed: [], includeChildren: true },
    assetTypes: { deny: [] },
    limits: DEFAULT_LIMITS,
    budget: createBudget(10),
    limiter: unboundedLimiter,
    breaker: closedBreaker,
    fetch: () => Promise.reject(new Error('no fetch in this test')),
    logger,
    clock: systemClock,
    random: webCryptoRandom,
    ...overrides,
  };
}
