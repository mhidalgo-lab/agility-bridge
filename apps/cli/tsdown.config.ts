// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  dts: false,
  clean: true,
  // The workspace packages are private: bundle them, from their sources, so the build never depends on a prior build of
  // core (a missing core/dist was left as an absolute import, P1-11 CI). Third-party packages stay dependencies.
  alias: {
    '@agility-bridge/admin-ui': fileURLToPath(
      new URL('../../packages/admin-ui/src/index.ts', import.meta.url),
    ),
    '@agility-bridge/auth': fileURLToPath(new URL('../../packages/auth/src/index.ts', import.meta.url)),
    '@agility-bridge/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    '@agility-bridge/http-app': fileURLToPath(
      new URL('../../packages/http-app/src/index.ts', import.meta.url),
    ),
    '@agility-bridge/storage': fileURLToPath(new URL('../../packages/storage/src/index.ts', import.meta.url)),
    '@agility-bridge/storage-sqlite': fileURLToPath(
      new URL('../../packages/storage-sqlite/src/index.ts', import.meta.url),
    ),
  },
  deps: { alwaysBundle: [/^@agility-bridge\//] },
  // One published file (scripts/check-package.ts): the admin panel is imported lazily (`import()`), and stays inside it.
  outputOptions: { inlineDynamicImports: true },
});
