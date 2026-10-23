// SPDX-License-Identifier: Apache-2.0
// Client snippets (P4-06, THREAT_MODEL T8, T13, L-133): every value reaches its format quoted (JSON, POSIX shell,
// PowerShell) so a hostile string cannot break out into a config or a shell; a token is only ever in the one snippet that
// needs it. The real-shell round trips and the guide comparison are in scripts/test/client-snippets.test.ts.
import { describe, expect, it } from 'vitest';
import {
  CLIENT_BUILDERS,
  clientSnippets,
  endpointFor,
  isWorkspaceSlug,
  powershellWord,
  type Snippet,
  type SnippetInput,
  serverName,
  shellWord,
  TOKEN_ENV,
  TOKEN_PLACEHOLDER,
} from '../src/snippets.ts';

const ORIGIN = 'https://agility-bridge.example.com';
const input = (over: Partial<SnippetInput> = {}): SnippetInput => ({
  endpoint: endpointFor(ORIGIN, 'my-team'),
  slug: 'my-team',
  auth: { kind: 'device-token' },
  ...over,
});
const byId = (snippets: readonly Snippet[], id: string): Snippet => {
  const found = snippets.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no snippet ${id}`);
  return found;
};

/** Strings that break out of a JSON string, a shell word, a PowerShell string or a `${…}` expansion. */
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

describe('endpoints and slugs', () => {
  it('builds the endpoint from the configured origin and a storage-valid slug', () => {
    expect(endpointFor(ORIGIN, 'my-team')).toBe(`${ORIGIN}/w/my-team/mcp`);
    expect(endpointFor(`${ORIGIN}//`, 'a')).toBe(`${ORIGIN}/w/a/mcp`);
    expect(serverName('my-team')).toBe('agility-my-team');
  });

  it('refuses any slug the storage would not hold', () => {
    for (const bad of ['', 'A', '-a', 'a-', 'a_b', 'a'.repeat(64), ...HOSTILE]) {
      expect(isWorkspaceSlug(bad), bad).toBe(false);
      expect(() => endpointFor(ORIGIN, bad), bad).toThrow(TypeError);
      expect(() => clientSnippets(input({ slug: bad })), bad).toThrow(TypeError);
    }
  });
});

describe('every client', () => {
  it('has snippets with unique ids that name the endpoint, and JSON that parses', () => {
    const all = clientSnippets(input());
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length);
    expect(CLIENT_BUILDERS.length).toBeGreaterThanOrEqual(7);
    for (const s of all) {
      expect(s.body, s.id).toContain(`${ORIGIN}/w/my-team/mcp`);
      if (s.format === 'json') expect(() => JSON.parse(s.body), s.id).not.toThrow();
    }
  });

  it("uses each client's documented shape", () => {
    const all = clientSnippets(input());
    const url = `${ORIGIN}/w/my-team/mcp`;
    const name = 'agility-my-team';
    const vscode = JSON.parse(byId(all, 'vscode').body);
    expect(vscode.inputs[0]).toMatchObject({ type: 'promptString', password: true });
    expect(vscode.servers[name]).toEqual({
      type: 'http',
      url,
      headers: { Authorization: `Bearer \${input:${vscode.inputs[0].id}}` },
    });
    expect(JSON.parse(byId(all, 'jetbrains').body).servers[name]).toEqual({
      url,
      requestInit: { headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` } },
    });
    expect(JSON.parse(byId(all, 'claude-code-json').body).mcpServers[name]).toEqual({
      type: 'http',
      url,
      headers: { Authorization: `Bearer \${${TOKEN_ENV}}` },
    });
    expect(JSON.parse(byId(all, 'cursor').body).mcpServers[name]).toEqual({
      url,
      headers: { Authorization: `Bearer \${env:${TOKEN_ENV}}` },
    });
    expect(JSON.parse(byId(all, 'windsurf').body).mcpServers[name]).toEqual({
      serverUrl: url,
      headers: { Authorization: `Bearer \${env:${TOKEN_ENV}}` },
    });
    expect(byId(all, 'claude-code').body).toContain('claude mcp add --transport http --scope user');
    expect(byId(all, 'copilot-cli').body).toContain('copilot mcp add --transport http --header');
    expect(byId(all, 'inspector').body).toContain('--cli');
  });
});

describe('the token', () => {
  const TOKEN = `ab_test_${'x'.repeat(8)}${crypto.randomUUID().replaceAll('-', '')}`;

  it('is in no snippet without one, and only in the JetBrains snippet with one', () => {
    for (const s of clientSnippets(input())) {
      expect(s.body, s.id).not.toMatch(/ab_(live|test)_/);
      expect(s.literalToken, s.id).toBe(false);
    }
    const issued = clientSnippets(input({ auth: { kind: 'device-token', token: TOKEN } }));
    const holders = issued.filter((s) => s.body.includes(TOKEN));
    expect(holders.map((s) => s.id)).toEqual(['jetbrains']);
    for (const s of issued) expect(s.literalToken, s.id).toBe(s.body.includes(TOKEN));
    // The placeholder is gone where the token went, and stays everywhere else a client needs one.
    expect(byId(issued, 'jetbrains').body).not.toContain(TOKEN_PLACEHOLDER);
  });

  it('never lands in a shell command, a prompt answer or a file the client can expand itself', () => {
    for (const s of clientSnippets(input({ auth: { kind: 'device-token', token: TOKEN } }))) {
      if (s.id === 'jetbrains') continue;
      expect(s.body, s.id).not.toContain(TOKEN);
      if (s.format !== 'json') expect(s.body, s.id).toContain(TOKEN_ENV);
    }
  });
});

describe('quoting: hostile values cannot break out', () => {
  it('JSON: a hostile token and endpoint come back as the same string', () => {
    for (const h of HOSTILE) {
      const all = clientSnippets(input({ endpoint: h, auth: { kind: 'device-token', token: h } }));
      for (const s of all.filter((x) => x.format === 'json')) {
        const parsed = JSON.parse(s.body);
        const server = Object.values(
          (parsed.servers ?? parsed.mcpServers) as Record<string, Record<string, unknown>>,
        );
        expect(server, s.id).toHaveLength(1);
        const entry = server[0] as Record<string, unknown>;
        expect(entry['url'] ?? entry['serverUrl'], s.id).toBe(h);
        if (s.id === 'jetbrains')
          expect((entry['requestInit'] as { headers: { Authorization: string } }).headers.Authorization).toBe(
            `Bearer ${h}`,
          );
      }
    }
  });

  it('shell: a bare word needs no quotes and a quote is closed, escaped and reopened', () => {
    expect(shellWord('https://a.example/w/x/mcp')).toBe('https://a.example/w/x/mcp');
    expect(shellWord("it's")).toBe(`'it'\\''s'`);
    expect(shellWord('a b')).toBe("'a b'");
    expect(shellWord('')).toBe("''");
  });

  it('PowerShell: always single-quoted, a quote doubled, nothing expands', () => {
    expect(powershellWord("it's")).toBe("'it''s'");
    expect(powershellWord('$env:HOME `n $(x)')).toBe("'$env:HOME `n $(x)'");
    for (const h of HOSTILE) {
      const w = powershellWord(h);
      expect(w.startsWith("'") && w.endsWith("'"), h).toBe(true);
      // No single quote inside is left alone.
      expect(w.slice(1, -1).replaceAll("''", ''), h).not.toContain("'");
    }
  });
});
