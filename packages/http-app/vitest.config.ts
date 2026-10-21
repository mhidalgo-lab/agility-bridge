// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`../${pkg}/src/index.ts`, import.meta.url));

export default defineProject({
  // Workspace packages resolve to their sources (see apps/cli/vitest.config.ts).
  resolve: {
    alias: {
      '@agility-bridge/auth': src('auth'),
      '@agility-bridge/core': src('core'),
      '@agility-bridge/storage': src('storage'),
    },
  },
  test: { name: 'http-app' },
});
