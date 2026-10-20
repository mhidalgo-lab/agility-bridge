// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findMissing, hasHeader } from '../check-spdx.ts';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('hasHeader', () => {
  it('accepts the header on the first line, or after a shebang', () => {
    expect(hasHeader('// SPDX-License-Identifier: Apache-2.0\nexport {};\n')).toBe(true);
    expect(hasHeader('#!/usr/bin/env node\n// SPDX-License-Identifier: Apache-2.0\n')).toBe(true);
  });

  it('refuses a missing or misplaced header', () => {
    expect(hasHeader('export {};\n')).toBe(false);
    expect(hasHeader('export {};\n// SPDX-License-Identifier: Apache-2.0\n')).toBe(false);
    expect(hasHeader('')).toBe(false);
  });
});

describe('findMissing', () => {
  it('fails on a file without the header and ignores git-ignored files', () => {
    const root = mkdtempSync(join(tmpdir(), 'ab-spdx-'));
    roots.push(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, '.gitignore'), 'dist/\n');
    writeFileSync(join(root, 'src', 'ok.ts'), '// SPDX-License-Identifier: Apache-2.0\nexport {};\n');
    writeFileSync(join(root, 'src', 'bad.ts'), 'export {};\n');
    writeFileSync(join(root, 'README.md'), '# not source\n');
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'built.mjs'), 'export {};\n');
    expect(findMissing(root)).toEqual(['src/bad.ts']);
  });
});
