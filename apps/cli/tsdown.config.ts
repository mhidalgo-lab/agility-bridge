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
    '@agility-bridge/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
  },
  deps: { alwaysBundle: [/^@agility-bridge\//] },
});
