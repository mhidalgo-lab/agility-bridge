// SPDX-License-Identifier: Apache-2.0
import {
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
    credential: { id: 'cred-1', kind: 'personal', token: new Secret('FAKE-token-1') },
    projects: { allowed: [], includeChildren: true },
    assetTypes: { deny: [] },
    limits: DEFAULT_LIMITS,
    budget: createBudget(10),
    limiter: unboundedLimiter,
    logger,
    clock: systemClock,
    random: webCryptoRandom,
    ...overrides,
  };
}
