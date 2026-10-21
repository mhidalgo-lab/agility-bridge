// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  // Scripts and their tests import the workspace packages from source (CI runs the tests before any build).
  resolve: {
    alias: {
      '@agility-bridge/core': fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: { name: 'scripts' },
});
