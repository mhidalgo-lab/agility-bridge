// SPDX-License-Identifier: Apache-2.0
// Client integrations (P8-06, ADR-0016, L-023, L-027): one generator feeds the command, the plugin and the docs, no file
// holds a token, and versions stay in step. Installs in real clients are an owner step: nothing here claims them.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import {
  CLIENTS,
  cursorInstallLink,
  snippet,
  TOKEN_PLACEHOLDER,
  URL_PLACEHOLDER,
  vscodeInstallLinks,
} from '../src/client-snippets.ts';
import { checkEnvNames } from '../src/config.ts';
import { main } from '../src/main.ts';
import { PLUGIN_PATH, pluginMcpJson } from '../src/plugin-mcp.ts';

const ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// A Windows checkout may turn LF into CRLF (core.autocrlf); compare the content, not the line endings.
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
const readJson = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;

const TOKEN = '1.IntegrationTestTokenNotReal0123456789AbCd';
/** Secret shapes that must never appear in an integration file (the families of `redact()` and `check-package`). */
const SECRET_SHAPES = [
  /\bab_(?:live|test|admin)_[A-Za-z0-9_]{16,}/,
  /\bBearer\s+(?:1\.)?[A-Za-z0-9+/=_-]{20,}/,
  /\b1\.[A-Za-z0-9+/=_-]{30,}/,
  /\bAB_MASTER_KEY\S*\s*[=:]\s*["']?v\d+:/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
];

function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(args, { env: {}, out: (t) => out.push(t), err: (t) => err.push(t) });
  return Promise.resolve(code).then((c) => ({ code: c, out: out.join('\n'), err: err.join('\n') }));
}

/** The token-bearing values of every `env` map in a snippet's JSON. */
function tokenValues(text: string): string[] {
  const found: string[] = [];
  const walk = (node: unknown) => {
    if (node === null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'AB_AGILITY_TOKEN' && typeof v === 'string') found.push(v);
      else walk(v);
    }
  };
  walk(JSON.parse(text));
  return found;
}

describe('snippets', () => {
  it.each(CLIENTS)(
    '%s: valid, no token, only known settings, the placeholder until told otherwise',
    (client) => {
      const s = snippet(client);
      for (const shape of SECRET_SHAPES) expect(s.text + (s.link ?? '')).not.toMatch(shape);
      if (s.format === 'json') {
        const doc = JSON.parse(s.text) as Record<string, unknown>;
        const servers = (doc['mcpServers'] ?? doc['servers']) as Record<
          string,
          { command: string; args: string[]; env: Record<string, string> }
        >;
        const entry = servers['agility'];
        expect(entry?.command).toBe('npx');
        expect(entry?.args).toEqual(['-y', 'agility-bridge']);
        expect(entry?.env['AB_AGILITY_URL']).toBe(URL_PLACEHOLDER);
        expect(() => checkEnvNames(entry?.env ?? {})).not.toThrow();
        // The token is a prompt, a variable, or a keychain reference: never a literal.
        expect(tokenValues(s.text)[0]).toMatch(/^(?:\$\{input:[a-z-]+\}|keychain:[A-Za-z0-9._@-]+)$/);
      } else {
        expect(s.text).toContain('claude mcp add agility');
        expect(s.text).toContain('AB_AGILITY_TOKEN=keychain:agility-token');
        expect(s.text).not.toContain(TOKEN);
      }
      expect(s.notes.join(' ')).toMatch(/restart|reconnect/i);
    },
  );

  it('takes a validated instance address, a keychain name and a pinned version', () => {
    const s = snippet('claude-desktop', {
      url: 'https://agility.example.com/Acme/',
      keychain: 'work',
      version: '1.2.3',
    });
    const entry = (
      JSON.parse(s.text) as { mcpServers: { agility: { args: string[]; env: Record<string, string> } } }
    ).mcpServers.agility;
    expect(entry.env['AB_AGILITY_URL']).toBe('https://agility.example.com/Acme');
    expect(entry.env['AB_AGILITY_TOKEN']).toBe('keychain:work');
    expect(entry.args).toEqual(['-y', 'agility-bridge@1.2.3']);
    for (const bad of [
      'http://agility.example.com/Acme',
      'not a url',
      'https://user:pw@agility.example.com/Acme',
    ]) {
      expect(() => snippet('cursor', { url: bad }), bad).toThrow(/--url/);
    }
  });

  it('the VS Code link carries the entry and a password prompt, never a token', () => {
    const { uri, web } = vscodeInstallLinks({ url: 'https://agility.example.com/Acme' });
    expect(uri.startsWith('vscode:mcp/install?')).toBe(true);
    const config = JSON.parse(decodeURIComponent(uri.slice('vscode:mcp/install?'.length))) as Record<
      string,
      unknown
    >;
    expect(config).toMatchObject({
      name: 'agility',
      type: 'stdio',
      command: 'npx',
      inputs: [{ type: 'promptString', id: 'agility-token', password: true }],
    });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a VS Code input reference, not a template
    expect((config['env'] as Record<string, string>)['AB_AGILITY_TOKEN']).toBe('${input:agility-token}');
    expect(web.startsWith('https://insiders.vscode.dev/redirect/mcp/install?')).toBe(true);
    for (const shape of SECRET_SHAPES) expect(uri + web).not.toMatch(shape);
  });

  it('the Cursor link carries a placeholder (or a keychain reference), never a token', () => {
    const link = cursorInstallLink({});
    expect(link.startsWith('cursor://anysphere.cursor-deeplink/mcp/install?name=agility&config=')).toBe(true);
    const config = JSON.parse(atob(decodeURIComponent(link.split('config=')[1] as string))) as {
      env: Record<string, string>;
    };
    expect(config.env['AB_AGILITY_TOKEN']).toBe(TOKEN_PLACEHOLDER);
    const ref = JSON.parse(
      atob(decodeURIComponent(cursorInstallLink({ keychain: 'work' }).split('config=')[1] as string)),
    ) as { env: Record<string, string> };
    expect(ref.env['AB_AGILITY_TOKEN']).toBe('keychain:work');
  });
});

describe('agility-bridge client-config', () => {
  it('prints the snippet on stdout and the notes on stderr', async () => {
    const r = await run([
      'client-config',
      'cursor',
      '--url',
      'https://agility.example.com/Acme',
      '--keychain',
      'work',
    ]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      mcpServers: { agility: { env: { AB_AGILITY_TOKEN: 'keychain:work' } } },
    });
    expect(r.err).toContain('agility-bridge keychain set work');
  });

  it('--link prints only the link, and a client without one is an error', async () => {
    expect((await run(['client-config', 'vscode', '--link'])).out).toMatch(/^vscode:mcp\/install\?/);
    const none = await run(['client-config', 'windsurf', '--link']);
    expect(none.code).toBe(1);
    expect(none.err).toContain('no install link');
  });

  it('refuses an unknown client, an unsafe address and a secret flag, printing no snippet', async () => {
    expect((await run(['client-config', 'emacs'])).code).toBe(1);
    const http = await run(['client-config', 'vscode', '--url', 'http://agility.example.com/Acme']);
    expect(http.code).toBe(1);
    expect(http.out).toBe('');
    expect((await run(['client-config', 'vscode', '--token', TOKEN])).code).toBe(2);
  });
});

describe('the Claude Code plugin', () => {
  const dir = PLUGIN_PATH;
  const manifest = () => readJson(`${dir}/.claude-plugin/plugin.json`);

  it("has a manifest that follows Claude Code's rules and prompts for its settings, the token marked sensitive", () => {
    const m = manifest() as {
      name: string;
      version: string;
      userConfig: Record<string, Record<string, unknown>>;
      license: string;
    };
    expect(m.name).toMatch(/^[a-z][a-z0-9-]*$/);
    // Names that pass as Anthropic's own are refused by `claude plugin validate` (checked 2026-10-30).
    expect(m.name).not.toMatch(/^(?:claude|anthropic|anthropics|cc-plugin)(?:-|$)|official/i);
    expect(m.license).toBe('Apache-2.0');
    for (const [key, field] of Object.entries(m.userConfig)) {
      expect(key).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      expect(
        Object.keys(field).every((k) =>
          [
            'type',
            'title',
            'description',
            'required',
            'default',
            'sensitive',
            'options',
            'multiple',
            'min',
            'max',
          ].includes(k),
        ),
      ).toBe(true);
      expect(field['type']).toBe('string');
      expect(typeof field['title']).toBe('string');
      expect(typeof field['description']).toBe('string');
    }
    expect(m.userConfig['agility_token']?.['sensitive']).toBe(true);
    expect(m.userConfig['agility_url']?.['sensitive']).toBeUndefined();
  });

  it('keeps its version, its pinned package and its .mcp.json in step with the CLI', () => {
    expect(manifest()['version']).toBe(pkg.version);
    expect(read(`${dir}/.mcp.json`)).toBe(pluginMcpJson(pkg.version));
  });

  it('.mcp.json only references settings its manifest declares, and holds no secret', () => {
    const text = read(`${dir}/.mcp.json`);
    const declared = Object.keys((manifest()['userConfig'] ?? {}) as object);
    const used = [...text.matchAll(/\$\{user_config\.([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const key of used) expect(declared).toContain(key);
    for (const shape of SECRET_SHAPES) expect(text).not.toMatch(shape);
    const entry = (JSON.parse(text) as { mcpServers: { agility: { env: Record<string, string> } } })
      .mcpServers.agility;
    expect(() => checkEnvNames(entry.env)).not.toThrow();
  });

  it('has commands and skills with a description, skill names matching their folders', () => {
    const commands = readdirSync(join(ROOT, dir, 'commands')).filter((f) => f.endsWith('.md'));
    expect(commands.sort()).toEqual(['find-item.md', 'my-work.md', 'sprint-status.md', 'standup.md']);
    for (const f of commands) {
      const body = read(`${dir}/commands/${f}`);
      expect(body, f).toMatch(/^---\ndescription: .+\n/);
      // Untrusted text and read-only conduct are part of every command (AGENTS.md, ADR-0015).
      expect(body, f).toMatch(/data[^.]*never[^.]*instructions|never as instructions/);
    }
    const skills = readdirSync(join(ROOT, dir, 'skills'));
    expect(skills.sort()).toEqual(['agility-conduct', 'agility-workflows']);
    for (const name of skills) {
      const body = read(`${dir}/skills/${name}/SKILL.md`);
      expect(body).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .{40,}\\n---`));
    }
  });

  it('names only tools that exist', () => {
    const tools = new Set(
      [...read('docs/reference/tools.md').matchAll(/^\| \[`([a-z_]+)`\]/gm)].map((m) => m[1]),
    );
    const files = [
      ...readdirSync(join(ROOT, dir, 'commands')).map((f) => `${dir}/commands/${f}`),
      ...readdirSync(join(ROOT, dir, 'skills')).map((n) => `${dir}/skills/${n}/SKILL.md`),
    ];
    for (const f of files) {
      for (const m of read(f).matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
        const name = m[1] as string;
        // Words in backticks that are not tool names: argument and field names.
        if (['hiddenOutsideScope', 'user_config'].includes(name)) continue;
        expect(tools.has(name), `${f}: \`${name}\``).toBe(true);
      }
    }
  });

  it('is offered by a marketplace file whose source exists', () => {
    const market = readJson('.claude-plugin/marketplace.json') as {
      name: string;
      owner: { name: string };
      plugins: { name: string; source: string }[];
    };
    expect(market.name).toBe('agility-bridge');
    expect(market.owner.name).toBeTruthy();
    const entry = market.plugins[0];
    expect(entry?.name).toBe(manifest()['name']);
    expect(entry?.source.startsWith('./')).toBe(true);
    expect(existsSync(join(ROOT, entry?.source ?? '', '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('every file of the plugin and the marketplace is free of secret shapes', () => {
    const files: string[] = ['.claude-plugin/marketplace.json'];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
        const next = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(next);
        else files.push(next);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(8);
    for (const f of files) for (const shape of SECRET_SHAPES) expect(read(f), f).not.toMatch(shape);
  });
});

describe('the MCP Registry metadata (server.json)', () => {
  const server = () =>
    readJson('server.json') as {
      $schema: string;
      name: string;
      description: string;
      version: string;
      repository: { url: string; source: string; subfolder?: string };
      packages: {
        registryType: string;
        identifier: string;
        version: string;
        transport: { type: string };
        environmentVariables: {
          name: string;
          isRequired?: boolean;
          isSecret?: boolean;
          description: string;
        }[];
      }[];
    };

  it('matches the package: name, mcpName, versions, repository, stdio', () => {
    const s = server();
    expect(s.$schema).toMatch(
      /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/.+\/server\.schema\.json$/,
    );
    expect(s.name).toBe((pkg as { mcpName?: string }).mcpName);
    expect(s.name).toMatch(/^io\.github\.[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/);
    expect(s.description.length).toBeLessThanOrEqual(100);
    expect(s.version).toBe(pkg.version);
    expect(s.repository.source).toBe('github');
    expect(s.repository.url).toBe('https://github.com/mhidalgo-lab/agility-bridge');
    expect(s.packages).toHaveLength(1);
    expect(s.packages[0]).toMatchObject({
      registryType: 'npm',
      identifier: pkg.name,
      version: pkg.version,
      transport: { type: 'stdio' },
    });
  });

  it('lists only settings the server knows, and marks the token secret', () => {
    const vars = server().packages[0]?.environmentVariables ?? [];
    expect(() => checkEnvNames(Object.fromEntries(vars.map((v) => [v.name, 'x'])))).not.toThrow();
    const token = vars.find((v) => v.name === 'AB_AGILITY_TOKEN');
    expect(token).toMatchObject({ isRequired: true, isSecret: true });
    for (const v of vars) {
      expect(v.description.length).toBeGreaterThan(10);
      for (const shape of SECRET_SHAPES) expect(JSON.stringify(v)).not.toMatch(shape);
    }
  });
});
