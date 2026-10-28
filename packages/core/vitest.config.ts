// SPDX-License-Identifier: Apache-2.0
import { defineProject } from 'vitest/config';

export default defineProject({
  // Property and world-building tests are CPU-bound: the 5 s default is a flake under a parallel run (P6-13, L-322).
  // `isolate: false` reuses one module graph per worker instead of loading it again for each of the 39 files (65 s to 21 s
  // wall, P6-44). Safe because the repository bans module-level request state; a test that leaves global state behind
  // shows up under `--sequence.shuffle` (run it when adding global spies or fake timers).
  test: { name: 'core', testTimeout: 20_000, isolate: false },
});
