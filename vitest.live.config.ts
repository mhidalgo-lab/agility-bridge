// SPDX-License-Identifier: Apache-2.0
// P0-12: the live suite against the read-only tenant (D-01). Never part of `pnpm test`; never on fork PRs.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  // Workspace packages resolve to their sources, as in the other suites (no build needed).
  resolve: {
    alias: {
      '@agility-bridge/auth': src('auth'),
      '@agility-bridge/core': src('core'),
      '@agility-bridge/http-app': src('http-app'),
      '@agility-bridge/storage': src('storage'),
    },
  },
  test: {
    include: ['live/**/*.live.test.ts'],
    testTimeout: 60_000,
    // One request at a time against a tenant we do not own.
    fileParallelism: false,
  },
});
