// SPDX-License-Identifier: Apache-2.0
// Builds the CLI once into its own directory (the published `dist` is never touched), then removes it afterwards.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI_DIR = fileURLToPath(new URL('../apps/cli/', import.meta.url));
export const OUT_DIR = join(CLI_DIR, 'dist-e2e-browser');

export default function globalSetup(): () => void {
  execFileSync(
    join(CLI_DIR, 'node_modules', '.bin', 'tsdown'),
    ['--out-dir', OUT_DIR, '--log-level', 'error'],
    {
      cwd: CLI_DIR,
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: 120_000,
    },
  );
  return () => rmSync(OUT_DIR, { recursive: true, force: true });
}
