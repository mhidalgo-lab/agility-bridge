// SPDX-License-Identifier: Apache-2.0
// Executable documentation (P1-14, L-133): every JSON snippet in the guides parses, client snippets only use known
// AB_ settings and keep the token out of plain text where they show one, every AB_ name the docs mention exists, and
// the shell blocks marked <!-- doc-test --> run against the CLI built from this checkout.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkEnvNames } from '../../apps/cli/src/config.ts';
import { ErrorCode } from '../../packages/core/src/index.ts';

const ROOT = new URL('../../', import.meta.url);
const DOCS = [
  'README.md',
  'apps/cli/README.md',
  ...readdirSync(new URL('docs/guide/', ROOT)).map((f) => `docs/guide/${f}`),
].filter((f) => f.endsWith('.md'));

interface Block {
  readonly file: string;
  readonly lang: string;
  readonly code: string;
  readonly test: boolean;
}

function blocks(file: string): Block[] {
  const text = readFileSync(new URL(file, ROOT), 'utf8');
  const out: Block[] = [];
  const re = /(<!-- doc-test -->\s*\n)?```(\w*)\n([\s\S]*?)```/g;
  for (const m of text.matchAll(re))
    out.push({ file, lang: m[2] ?? '', code: m[3] ?? '', test: m[1] !== undefined });
  return out;
}

const ALL = DOCS.flatMap(blocks);
/** Placeholders and references that keep a real token out of the snippet. */
const SAFE_TOKEN = /^(?:<your access token>|\$\{[A-Za-z_:.-]+\}|\$\{input:[a-z-]+\})$/;

describe('documentation snippets', () => {
  it.each(ALL.filter((b) => b.lang === 'json').map((b) => [b.file, b] as const))(
    'JSON in %s parses and uses known settings',
    (_f, b) => {
      const json = JSON.parse(b.code) as Record<string, unknown>;
      const servers = (json['mcpServers'] ?? json['servers'] ?? {}) as Record<
        string,
        { env?: Record<string, string> }
      >;
      for (const server of Object.values(servers)) {
        const env = server.env ?? {};
        expect(() => checkEnvNames(env)).not.toThrow();
        if (env['AB_AGILITY_TOKEN'] !== undefined) expect(env['AB_AGILITY_TOKEN']).toMatch(SAFE_TOKEN);
      }
    },
  );

  it('mentions only AB_ settings that exist', () => {
    const names = new Set<string>();
    for (const file of DOCS) {
      for (const m of readFileSync(new URL(file, ROOT), 'utf8').matchAll(/\bAB_[A-Z0-9_]*[A-Z0-9]\b/g))
        names.add(m[0]);
    }
    // Error codes share the prefix; `AB_CODE` is the docs' placeholder for one.
    const codes = new Set<string>([...Object.values(ErrorCode), 'AB_CODE']);
    const env = Object.fromEntries([...names].filter((n) => !codes.has(n)).map((n) => [n, 'x']));
    expect(() => checkEnvNames(env)).not.toThrow();
  });

  it.each(ALL.filter((b) => b.test).map((b) => [`${b.file}: ${b.code.trim()}`, b] as const))(
    'runs %s',
    (_n, b) => {
      for (const line of b.code.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'))) {
        const args = line.trim().split(/\s+/);
        // `npx -y agility-bridge …` runs the CLI of this checkout.
        expect(args.slice(0, 3)).toEqual(['npx', '-y', 'agility-bridge']);
        const out = execFileSync(
          process.execPath,
          ['--conditions=source', 'apps/cli/src/index.ts', ...args.slice(3)],
          {
            cwd: ROOT,
            env: { PATH: process.env['PATH'] ?? '' },
            encoding: 'utf8',
            timeout: 30_000,
          },
        );
        expect(out).toMatch(/agility-bridge/);
      }
    },
  );
});
