// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSource, findViolations } from '../check-runtime-imports.ts';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ab-runtime-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const web = JSON.stringify({ name: '@agility-bridge/core', agilityBridge: { runtime: 'web' } });
const node = JSON.stringify({ name: 'agility-bridge', agilityBridge: { runtime: 'node' } });

describe('checkSource', () => {
  it.each([
    "import { readFileSync } from 'node:fs';",
    "import fs from 'fs';",
    "import { join } from 'path/posix';",
    "export { x } from 'node:crypto';",
    "const m = await import('node:sqlite');",
    "import 'node:process';",
    'const key = process.env.KEY;',
    "const b = Buffer.from('x');",
    'const here = __dirname;',
    "const x = require('x');",
  ])('refuses %s', (source) => {
    expect(checkSource('f.ts', source)).toHaveLength(1);
  });

  it('accepts web-standard code', () => {
    const source = [
      "import { z } from 'zod';",
      "import type { Tool } from './tool.ts';",
      'const id = crypto.randomUUID();',
      "const url = new URL('https://example.com');",
      'const bytes = new TextEncoder().encode(id);',
    ].join('\n');
    expect(checkSource('f.ts', source)).toEqual([]);
  });

  it('reports the line number', () => {
    expect(checkSource('f.ts', "const a = 1;\nimport fs from 'node:fs';")[0]?.line).toBe(2);
  });
});

describe('findViolations', () => {
  it('fails on a node: import in packages/core', () => {
    const root = workspace({
      'packages/core/package.json': web,
      'packages/core/src/index.ts': 'export {};\n',
      'packages/core/src/deep/clock.ts': "import { setTimeout } from 'node:timers/promises';\n",
    });
    expect(findViolations(root)).toEqual([
      expect.objectContaining({ file: join('packages', 'core', 'src', 'deep', 'clock.ts'), line: 1 }),
    ]);
  });

  it('ignores Node packages and passes clean web packages', () => {
    const root = workspace({
      'packages/core/package.json': web,
      'packages/core/src/index.ts': "export const ok = new URL('https://example.com');\n",
      'apps/cli/package.json': node,
      'apps/cli/src/index.ts': "import { readFileSync } from 'node:fs';\n",
    });
    expect(findViolations(root)).toEqual([]);
  });
});
