// SPDX-License-Identifier: Apache-2.0
// ADR-0003: every source file starts with an SPDX license header (shebang line allowed first).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEADER = 'SPDX-License-Identifier: Apache-2.0';
const SOURCE_RE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

export function hasHeader(source: string): boolean {
  const lines = source.split('\n');
  const first = lines[0]?.startsWith('#!') ? lines[1] : lines[0];
  return first?.includes(HEADER) ?? false;
}

/** Source files under `root` (tracked, or untracked and not ignored) that lack the header. */
export function findMissing(root: string): string[] {
  // Untracked files count too, so the check works before the first commit.
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => SOURCE_RE.test(f));
  return files.filter((f) => {
    try {
      return !hasHeader(readFileSync(join(root, f), 'utf8'));
    } catch {
      return false; // deleted in the working tree
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const missing = findMissing(fileURLToPath(new URL('..', import.meta.url)));
  for (const f of missing) console.error(`✗ ${f}: missing "// ${HEADER}" header`);
  process.exit(missing.length === 0 ? 0 : 1);
}
