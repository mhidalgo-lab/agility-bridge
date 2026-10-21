// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  // The workspace's own packages resolve to their sources, so tests need no build first. An alias, not the `source`
  // export condition: third-party packages publish that condition too, pointing at TypeScript inside node_modules.
  resolve: {
    alias: {
      '@agility-bridge/auth': fileURLToPath(new URL('../../packages/auth/src/index.ts', import.meta.url)),
      '@agility-bridge/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@agility-bridge/http-app': fileURLToPath(
        new URL('../../packages/http-app/src/index.ts', import.meta.url),
      ),
      '@agility-bridge/storage': fileURLToPath(
        new URL('../../packages/storage/src/index.ts', import.meta.url),
      ),
      '@agility-bridge/storage-sqlite': fileURLToPath(
        new URL('../../packages/storage-sqlite/src/index.ts', import.meta.url),
      ),
    },
  },
  test: { name: 'cli' },
});
