// SPDX-License-Identifier: Apache-2.0
// P0-12: the live suite against the read-only tenant (D-01). Never part of `pnpm test`; never on fork PRs.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['live/**/*.live.test.ts'],
    testTimeout: 60_000,
    // One request at a time against a tenant we do not own.
    fileParallelism: false,
  },
});
