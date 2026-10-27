// SPDX-License-Identifier: Apache-2.0
import { defineProject } from 'vitest/config';

export default defineProject({
  // Property and world-building tests are CPU-bound: the 5 s default is a flake under a parallel run (P6-13, L-322).
  test: { name: 'core', testTimeout: 20_000 },
});
