// SPDX-License-Identifier: Apache-2.0
import { defineProject } from 'vitest/config';

export default defineProject({
  // Workspace packages resolve to their sources (the `source` export condition), so tests need no build first.
  resolve: { conditions: ['source', 'module', 'node', 'import', 'default'] },
  ssr: { resolve: { conditions: ['source', 'module', 'node', 'import', 'default'] } },
  test: { name: 'cli' },
});
