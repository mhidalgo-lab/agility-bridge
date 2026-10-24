// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`../${pkg}/src/index.ts`, import.meta.url));

export default defineProject({
  // Workspace packages resolve to their sources (see apps/cli/vitest.config.ts).
  resolve: {
    alias: {
      '@agility-bridge/admin-ui': src('admin-ui'),
      '@agility-bridge/auth': src('auth'),
      '@agility-bridge/core': src('core'),
      '@agility-bridge/storage': src('storage'),
      // The OAuth provider imports `WorkerEntrypoint` for `instanceof` checks only (ADR-0009).
      'cloudflare:workers': fileURLToPath(new URL('./src/oauth/cloudflare-workers-shim.ts', import.meta.url)),
    },
  },
  test: {
    name: 'http-app',
    // Transformed by Vite (not loaded by Node) so the `cloudflare:workers` alias applies inside it.
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
  },
});
