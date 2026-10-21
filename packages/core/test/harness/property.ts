// SPDX-License-Identifier: Apache-2.0
// Seeded, replayable property tests (L-123). The seed is fixed so CI is deterministic; set AB_TEST_SEED to explore,
// and fast-check prints the seed and path of a failure so it can be replayed exactly.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

export const PROPERTY_SEED: number =
  Number.isInteger(Number(env['AB_TEST_SEED'])) && env['AB_TEST_SEED'] !== undefined
    ? Number(env['AB_TEST_SEED'])
    : 20261021;

/** fast-check parameters for every property test. */
export function propertyParams(numRuns = 200): {
  readonly seed: number;
  readonly numRuns: number;
  readonly endOnFailure: boolean;
} {
  return { seed: PROPERTY_SEED, numRuns, endOnFailure: false };
}
