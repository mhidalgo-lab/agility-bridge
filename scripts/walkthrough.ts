// SPDX-License-Identifier: Apache-2.0
// The self-hosting walkthrough, executed (P2-16, L-133): the shell blocks marked `<!-- walkthrough: N -->` in the guides
// run in order, verbatim, in a fresh Node 24 container that installs the package built from this checkout, against the
// synthetic Agility. Only these substitutions are made, and they are printed: the npm package name → the packed
// tarball; the example instance and public URLs → the synthetic Agility and the local server; `<…-id>` placeholders →
// the ids the previous commands printed; `agility-bridge serve` → started in the background until /health answers.
//   pnpm --filter agility-bridge build && mkdir -p /tmp/pkg && (cd apps/cli && npm pack --pack-destination /tmp/pkg)
//   node --conditions=source scripts/walkthrough.ts /tmp/pkg/agility-bridge-<version>.tgz
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GUIDES = ['docs/guide/self-hosting.md', 'docs/guide/cli.md'];
const IMAGE = 'node:24-bookworm@sha256:7b559cf7f77d837192392499a850abb1a3d1f49fbc2bd0692d54b212c9e38f6d';
const AGILITY = 'http://127.0.0.1:18788/SyntheticInstance';

/** The marked blocks, by step number. */
export function walkthroughBlocks(
  files: readonly string[] = GUIDES,
): { step: number; file: string; lines: string[] }[] {
  const blocks: { step: number; file: string; lines: string[] }[] = [];
  for (const file of files) {
    const text = readFileSync(resolve(ROOT, file), 'utf8');
    for (const m of text.matchAll(/<!-- walkthrough: (\d+) -->\s*\n```sh\n([\s\S]*?)```/g)) {
      blocks.push({
        step: Number(m[1]),
        file,
        lines: (m[2] as string).split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#')),
      });
    }
  }
  return blocks.sort((a, b) => a.step - b.step);
}

const CAPTURES: [RegExp, string, string][] = [
  [/^agility-bridge instance add /, 'INSTANCE_ID', '.id'],
  [/^agility-bridge credential add /, 'CREDENTIAL_ID', '.id'],
  [/^agility-bridge user add /, 'USER_ID', '.id'],
  [/^agility-bridge workspace add /, 'WORKSPACE_ID', '.id'],
  [/^agility-bridge grant add /, 'GRANT_ID', '.record.id'],
  [/^agility-bridge token issue /, 'DEVICE_TOKEN', '.token'],
];

/** The bash script the container runs. */
export function script(tarball: string): string {
  const out = [
    'set -euo pipefail',
    'cd /root',
    'node --conditions=source /src/scripts/fixture-agility.ts 18788 > /tmp/agility.log 2>&1 &',
    // A token file for `credential add --from-file`, as an operator would have saved it.
    "printf 'synthetic-service-token-any-value' > ./service.token && chmod 600 ./service.token",
    "json() { node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(eval('JSON.parse(s)'+process.argv[1])))\" \"$1\"; }",
  ];
  for (const block of walkthroughBlocks()) {
    out.push(`echo "### walkthrough step ${block.step} (${block.file})"`);
    for (const original of block.lines) {
      const line = original
        .replace(/^npm install -g agility-bridge$/, `npm install -g /pkg/${basename(tarball)}`)
        .replaceAll('https://www7.v1host.com/YourInstance', AGILITY)
        .replaceAll('https://mcp.example.com', 'http://127.0.0.1:8787')
        .replace(/<([a-z]+)-id>/g, (_m, name: string) => `"$${name.toUpperCase()}_ID"`);
      if (line !== original)
        out.push(`echo "# substituted: ${original.replaceAll('"', '\\"').replaceAll('$', '\\$')}"`);
      out.push(`echo '$ ${line.replaceAll("'", "'\\''")}'`);
      if (/agility-bridge serve$/.test(line)) {
        out.push(`${line} > /tmp/serve.log 2>&1 &`);
        out.push(
          'for i in $(seq 1 60); do curl -sf http://127.0.0.1:8787/health >/dev/null && break; sleep 0.5; done',
        );
        continue;
      }
      const capture = CAPTURES.find(([re]) => re.test(line));
      if (capture !== undefined) {
        // CI logs are public: device tokens never appear in them, not even throwaway ones.
        out.push(
          `out="$(${line})"`,
          "printf '%s\\n' \"$out\" | sed -E 's/ab_(live|test)_[A-Za-z0-9_]+/ab_\\1_[REDACTED]/g'",
          `export ${capture[1]}="$(printf '%s' "$out" | json '${capture[2]}')"`,
        );
      } else if (line.startsWith('curl ')) {
        out.push(`${line} | tee -a /tmp/curl.out`, 'echo');
      } else {
        out.push(line);
      }
    }
  }
  // The walkthrough ends with a working device token: the tool list it got must name the granted tools.
  out.push(
    'grep -q \'"status":"ok"\' /tmp/curl.out',
    'grep -q search_work_items /tmp/curl.out',
    'echo "walkthrough passed"',
  );
  return `${out.join('\n')}\n`;
}

if (import.meta.main) {
  const tarball = process.argv[2];
  if (tarball === undefined) {
    console.error('usage: node --conditions=source scripts/walkthrough.ts <agility-bridge-x.y.z.tgz>');
    process.exit(2);
  }
  const path = resolve(tarball);
  const scriptPath = resolve(dirname(path), 'walkthrough.sh');
  writeFileSync(scriptPath, script(path));
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${ROOT}:/src:ro`,
      '-v',
      `${dirname(path)}:/pkg:ro`,
      IMAGE,
      'bash',
      `/pkg/${basename(scriptPath)}`,
    ],
    { stdio: 'inherit' },
  );
}
