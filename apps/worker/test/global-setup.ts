// SPDX-License-Identifier: Apache-2.0
// Builds the Worker bundles once, before any test file starts (L-380). Test files run in parallel; when each built the
// bundle itself, `wrangler deploy --dry-run --outdir dist` rewrote `dist/index.js` (truncate, then write) while another
// file's Miniflare was loading it, which showed up as an empty or half-written script: a 500, or a bundle of 0 bytes.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export default function setup(): void {
  const wrangler = join(ROOT, 'node_modules', '.bin', 'wrangler');
  const build = (args: string[]) =>
    execFileSync(wrangler, ['deploy', '--dry-run', ...args], { cwd: ROOT, stdio: 'ignore' });
  // The bundle CI deploys, built the same way as `pnpm build`.
  build(['--outdir', 'dist']);
  // The Worker plus the consent stand-in (test/fixtures/oauth-entry.ts), bundled by wrangler like the real one.
  build(['--outdir', 'dist/oauth-test', 'test/fixtures/oauth-entry.ts']);
}
