// SPDX-License-Identifier: Apache-2.0
// P0-01: only the CLI is publishable, and every dependency is pinned to an exact version.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface Manifest {
  name: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function manifests(): Array<{ path: string; pkg: Manifest }> {
  const paths = ['package.json'];
  for (const group of ['packages', 'apps']) {
    for (const name of readdirSync(join(ROOT, group))) paths.push(join(group, name, 'package.json'));
  }
  return paths.map((path) => ({ path, pkg: JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as Manifest }));
}

describe('workspace packages', () => {
  it('publishes only the agility-bridge CLI', () => {
    const publishable = manifests()
      .filter(({ pkg }) => pkg.private !== true)
      .map(({ path, pkg }) => `${pkg.name} (${path})`);
    expect(publishable).toEqual([`agility-bridge (${join('apps', 'cli', 'package.json')})`]);
  });

  it('pins every dependency to an exact version', () => {
    const exact = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
    const loose = manifests().flatMap(({ path, pkg }) =>
      [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies].flatMap((deps) =>
        Object.entries(deps ?? {})
          .filter(([, spec]) => spec !== 'workspace:*' && !exact.test(spec))
          .map(([name, spec]) => `${path}: ${name}@${spec}`),
      ),
    );
    expect(loose).toEqual([]);
  });
});
