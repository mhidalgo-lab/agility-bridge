// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  // Workspace packages resolve to their sources (see apps/cli/vitest.config.ts).
  resolve: {
    alias: {
      '@agility-bridge/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@agility-bridge/storage': fileURLToPath(new URL('../storage/src/index.ts', import.meta.url)),
    },
  },
  test: { name: 'auth' },
});
