// SPDX-License-Identifier: Apache-2.0
// Client snippets against the real tools around them (P4-06, L-133, L-210): hostile values go through a real `bash` (and
// `pwsh` when installed) and arrive as exactly one argument; the guide's remote snippets are the generated ones. Lives with
// the repository scripts because it needs Node (`admin-ui` is web-standard only).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  clientSnippets,
  endpointFor,
  powershellWord,
  type Snippet,
  type SnippetInput,
  shellWord,
  TOKEN_ENV,
} from '../../packages/admin-ui/src/snippets.ts';

const input = (over: Partial<SnippetInput> = {}): SnippetInput => ({
  endpoint: endpointFor('https://agility-bridge.example.com', 'my-team'),
  slug: 'my-team',
  auth: { kind: 'device-token' },
  ...over,
});
const byId = (snippets: readonly Snippet[], id: string): Snippet => {
  const found = snippets.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no snippet ${id}`);
  return found;
};
const HOSTILE = [
  `"; rm -rf ~ #`,
  `'; touch /tmp/pwned; '`,
  `$(touch /tmp/pwned)`,
  '`touch /tmp/pwned`',
  '${input:other}',
  '${env:SECRET}',
  `a\nb"c\\d'e`,
  `\u0001\u2028</script><img src=x onerror=alert(1)>`,
  `' --header 'X: y`,
  `"},"evil":{"x":"`,
];
const hasBash = spawnSync('bash', ['-c', 'true']).status === 0;
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$true']).status === 0;

function bash(script: string): string {
  const res = spawnSync('bash', ['--noprofile', '--norc', '-c', script], { encoding: 'utf8' });
  expect(res.stderr).toBe('');
  return res.stdout;
}

describe('quoting through the real shells', () => {
  it.skipIf(!hasBash)('shell: every word reaches the command as exactly one argument (real bash)', () => {
    for (const h of HOSTILE) {
      expect(bash(`printf '%s' ${shellWord(h)}`), h).toBe(h);
    }
    const stubs =
      'claude(){ printf "%s\\n" "$@"; }; copilot(){ printf "%s\\n" "$@"; }; npx(){ printf "%s\\n" "$@"; }; ';
    for (const h of HOSTILE) {
      const all = clientSnippets(input({ endpoint: h }));
      for (const id of ['claude-code', 'copilot-cli', 'inspector']) {
        const lines = byId(all, id).body.split('\n');
        // The first two lines read the token from the terminal: the test sets it instead.
        const script = `${TOKEN_ENV}=T; ${stubs}${lines.slice(2).join('\n')}`;
        const out = bash(script);
        const args = out.split('\n');
        // The hostile value is one argument; nothing was executed (it would have printed or touched something).
        expect(args.filter((a) => a === h).length, `${id}: ${h}`).toBe(h.includes('\n') ? 0 : 1);
        expect(out, id).toContain('Authorization: Bearer T');
      }
    }
  });

  it.skipIf(!hasPwsh)('PowerShell: the word reaches the command unchanged (real pwsh)', () => {
    for (const h of HOSTILE.filter((x) => !x.includes('\u0001'))) {
      const out = spawnSync(
        'pwsh',
        ['-NoProfile', '-Command', `[Console]::Out.Write(${powershellWord(h)})`],
        {
          encoding: 'utf8',
        },
      ).stdout;
      expect(out, h).toBe(h);
    }
  });
});

describe('the guide', () => {
  it('shows the generated snippets, character for character (L-133)', () => {
    const md = readFileSync(new URL('../../docs/guide/clients.md', import.meta.url), 'utf8');
    const documented = new Map<string, string>();
    for (const m of md.matchAll(/<!-- snippet: ([a-z-]+) -->\n```[a-z]*\n([\s\S]*?)\n```/g))
      documented.set(m[1] as string, m[2] as string);
    const generated = clientSnippets(input());
    expect([...documented.keys()]).toEqual(generated.map((s) => s.id));
    for (const s of generated) expect(documented.get(s.id), s.id).toBe(s.body);
  });
});
