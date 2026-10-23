// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`../../packages/${pkg}/src/index.ts`, import.meta.url));

export default defineProject({
  // The tests run in Node and drive the bundled Worker in workerd (Miniflare); they import workspace packages only to
  // generate keys and tokens (see apps/cli/vitest.config.ts for the aliases).
  resolve: {
    alias: {
      '@agility-bridge/admin-ui': src('admin-ui'),
      '@agility-bridge/auth': src('auth'),
      '@agility-bridge/core': src('core'),
      '@agility-bridge/http-app': src('http-app'),
      '@agility-bridge/storage': src('storage'),
    },
  },
  test: { name: 'worker', testTimeout: 60_000, hookTimeout: 120_000 },
});
