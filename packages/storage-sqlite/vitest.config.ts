// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  // Workspace packages resolve to their sources (see apps/cli/vitest.config.ts).
  resolve: {
    alias: {
      '@agility-bridge/storage': fileURLToPath(new URL('../storage/src/index.ts', import.meta.url)),
    },
  },
  // Real database files: every commit, VACUUM and migration fsyncs, which on the Windows runner takes seconds a test,
  // not the 5 s default (as for apps/cli, L-104). Legitimately slow work, so a longer limit, not a weaker test.
  test: { name: 'storage-sqlite', testTimeout: 60_000 },
});
