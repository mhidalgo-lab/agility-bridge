// SPDX-License-Identifier: Apache-2.0
// Client configuration snippets (P4-06). Pure text, web-standard: the Connect page and the one-time token page render them.
//
// Rules (THREAT_MODEL T8, T13; L-026, L-085):
//  - The endpoint comes from the configured public origin (`AB_PUBLIC_URL`), never from a request header.
//  - A token never goes into a shell command (shell history) or into a file the client can expand or prompt for itself:
//    those snippets read it from `AGILITY_BRIDGE_TOKEN` or a password prompt. Only a client with neither mechanism
//    (JetBrains) takes the literal value, and only when the page was rendered right after the token was issued.
//  - Every interpolated value is quoted for its target format (JSON string, POSIX shell word, PowerShell string) and the
//    slug must match the storage rule, so `${...}` expansion inside a client's configuration cannot be smuggled in.
//  - Adding a sign-in method (Phase 5 OAuth) means a new `SnippetAuth` case and a branch in each builder that supports
//    it: the registry, the page and the existing snippets stay as they are.

/** Environment variable the shell and `${VAR}` snippets read the device token from. */
export const TOKEN_ENV = 'AGILITY_BRIDGE_TOKEN';
/** Shown wherever the real token must not (or cannot) appear. */
export const TOKEN_PLACEHOLDER = 'ab_<your device token>';

/** How the client signs in. Today only a static device token; OAuth (Phase 5) becomes a second case. */
export type SnippetAuth = {
  readonly kind: 'device-token';
  /** The just-issued token, only on the one-time page (`undefined` everywhere else). */
  readonly token?: string | undefined;
};

export interface Snippet {
  readonly id: string;
  readonly client: string;
  /** Where the text goes, one line. */
  readonly where: string;
  readonly format: 'json' | 'shell' | 'powershell';
  readonly body: string;
  /** Short caveats, plain text. */
  readonly notes: readonly string[];
  /** The body holds the literal token (never on the Connect page). */
  readonly literalToken: boolean;
}

export interface SnippetInput {
  /** `https://host/w/<slug>/mcp`, built by {@link endpointFor}. */
  readonly endpoint: string;
  /** Workspace slug (`[a-z0-9-]`), used in the server name. */
  readonly slug: string;
  readonly auth: SnippetAuth;
}

/** A client the page can show. */
interface ClientBuilder {
  readonly id: string;
  /** Snippets for this client, or none when it has no form for this sign-in method. */
  build(input: SnippetInput): readonly Snippet[];
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The storage rule for a workspace slug. */
export function isWorkspaceSlug(value: string): boolean {
  return SLUG.test(value);
}

/** The endpoint of a workspace: the configured origin plus `/w/<slug>/mcp`. Throws for a slug the storage would not hold. */
export function endpointFor(publicOrigin: string, slug: string): string {
  if (!isWorkspaceSlug(slug)) throw new TypeError('not a workspace slug');
  return `${publicOrigin.replace(/\/+$/, '')}/w/${slug}/mcp`;
}

export function serverName(slug: string): string {
  return `agility-${slug}`;
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/** POSIX shell word: bare when it only has safe characters, else single-quoted. */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9_\-./:@%+=,]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** PowerShell string: always single-quoted (nothing expands inside), a quote is doubled. */
export function powershellWord(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const bearerEnv = `Bearer \${${TOKEN_ENV}}`;
const READ_TOKEN = [
  `read -rs ${TOKEN_ENV}   # paste the token, press Enter: nothing is echoed or kept in history`,
  `export ${TOKEN_ENV}`,
];

const shell = (
  id: string,
  client: string,
  where: string,
  lines: readonly string[],
  notes: readonly string[],
): Snippet => ({
  id,
  client,
  where,
  format: 'shell',
  body: lines.join('\n'),
  notes,
  literalToken: false,
});

const vscode: ClientBuilder = {
  id: 'vscode',
  build: ({ endpoint, slug }) => [
    {
      id: 'vscode',
      client: 'GitHub Copilot in VS Code',
      where: '.vscode/mcp.json, or "MCP: Open User Configuration" for every workspace.',
      format: 'json',
      body: json({
        inputs: [
          {
            type: 'promptString',
            id: 'agility-bridge-token',
            description: 'agility-bridge device token',
            password: true,
          },
        ],
        servers: {
          [serverName(slug)]: {
            type: 'http',
            url: endpoint,
            headers: { Authorization: 'Bearer ${input:agility-bridge-token}' },
          },
        },
      }),
      notes: [
        'VS Code asks for the token once and keeps it in its secret storage, out of the file.',
        'Servers that use ${input:…} are not forwarded to Copilot agent sessions started outside the editor: use the user configuration there.',
      ],
      literalToken: false,
    },
  ],
};

const jetbrains: ClientBuilder = {
  id: 'jetbrains',
  build: ({ endpoint, slug, auth }) => [
    {
      id: 'jetbrains',
      client: 'GitHub Copilot in JetBrains IDEs',
      where: 'Settings > Tools > GitHub Copilot > Model Context Protocol > Configure (mcp.json).',
      format: 'json',
      body: json({
        servers: {
          [serverName(slug)]: {
            url: endpoint,
            requestInit: { headers: { Authorization: `Bearer ${auth.token ?? TOKEN_PLACEHOLDER}` } },
          },
        },
      }),
      notes: [
        auth.token === undefined
          ? 'This client cannot read the token from a variable or a prompt: paste it in place of the placeholder when you create it.'
          : 'This file holds the token in plain text: keep it private and out of backups you share.',
        'Use a short lifetime for this device token: the IDE stores the file unencrypted.',
      ],
      literalToken: auth.token !== undefined,
    },
  ],
};

const copilotCli: ClientBuilder = {
  id: 'copilot-cli',
  build: ({ endpoint, slug }) => [
    shell(
      'copilot-cli',
      'GitHub Copilot CLI',
      'Run in a terminal on the device (bash or zsh).',
      [
        ...READ_TOKEN,
        `copilot mcp add --transport http --header "Authorization: Bearer $${TOKEN_ENV}" \\`,
        `  ${shellWord(serverName(slug))} ${shellWord(endpoint)}`,
      ],
      [
        'The command writes the header, with the token, to ~/.copilot/mcp-config.json: keep that file readable only by you (chmod 600).',
        'Inside the CLI, /mcp add opens the same form (type HTTP, the URL, the header as JSON).',
      ],
    ),
  ],
};

const claudeCode: ClientBuilder = {
  id: 'claude-code',
  build: ({ endpoint, slug }) => [
    shell(
      'claude-code',
      'Claude Code (command)',
      'Run in a terminal on the device (bash or zsh).',
      [
        ...READ_TOKEN,
        `claude mcp add --transport http --scope user ${shellWord(serverName(slug))} ${shellWord(endpoint)} \\`,
        `  --header "Authorization: Bearer $${TOKEN_ENV}"`,
      ],
      [
        'Claude Code stores the header, with the token, in ~/.claude.json (user scope). Check with claude mcp list or /mcp.',
        'The command does not check the token: a wrong one fails later.',
      ],
    ),
    {
      id: 'claude-code-powershell',
      client: 'Claude Code (command, Windows PowerShell)',
      where: 'Run in PowerShell 7 on the device.',
      format: 'powershell',
      body: [
        `$env:${TOKEN_ENV} = Read-Host -MaskInput 'Device token'`,
        `claude mcp add --transport http --scope user ${powershellWord(serverName(slug))} ${powershellWord(endpoint)} \``,
        `  --header "Authorization: Bearer $env:${TOKEN_ENV}"`,
      ].join('\n'),
      notes: ['Read-Host -MaskInput needs PowerShell 7.1 or later.'],
      literalToken: false,
    },
    {
      id: 'claude-code-json',
      client: 'Claude Code (.mcp.json)',
      where: '.mcp.json in a project (safe to commit: it holds no token).',
      format: 'json',
      body: json({
        mcpServers: {
          [serverName(slug)]: { type: 'http', url: endpoint, headers: { Authorization: bearerEnv } },
        },
      }),
      notes: [
        `Claude Code expands \${${TOKEN_ENV}}: define it where Claude Code starts (your shell profile) and restart it.`,
        'Credential-looking variables referenced from a project file can resolve to empty for remote servers: keep the variable name above, and use the command (user scope) if the header arrives empty.',
        'A configured Authorization header is not replaced by OAuth: remove it if the server later offers OAuth.',
      ],
      literalToken: false,
    },
  ],
};

const cursor: ClientBuilder = {
  id: 'cursor',
  build: ({ endpoint, slug }) => [
    {
      id: 'cursor',
      client: 'Cursor',
      where: '~/.cursor/mcp.json (all projects) or .cursor/mcp.json.',
      format: 'json',
      body: json({
        mcpServers: {
          [serverName(slug)]: { url: endpoint, headers: { Authorization: `Bearer \${env:${TOKEN_ENV}}` } },
        },
      }),
      notes: [
        `Cursor expands \${env:${TOKEN_ENV}}: set the variable before starting Cursor.`,
        'Cursor shows at most 40 tools across all servers.',
      ],
      literalToken: false,
    },
  ],
};

const windsurf: ClientBuilder = {
  id: 'windsurf',
  build: ({ endpoint, slug }) => [
    {
      id: 'windsurf',
      client: 'Windsurf / Devin Desktop',
      where: '~/.config/devin/mcp_config.json (Windows: %APPDATA%\\devin\\mcp_config.json).',
      format: 'json',
      body: json({
        mcpServers: {
          [serverName(slug)]: {
            serverUrl: endpoint,
            headers: { Authorization: `Bearer \${env:${TOKEN_ENV}}` },
          },
        },
      }),
      notes: [
        `The client expands \${env:${TOKEN_ENV}} (an unset variable becomes empty): set it before starting the app.`,
        'Older builds dropped custom headers; this form is from the vendor documentation and not yet run against agility-bridge.',
      ],
      literalToken: false,
    },
  ],
};

const inspector: ClientBuilder = {
  id: 'inspector',
  build: ({ endpoint }) => [
    shell(
      'inspector',
      'MCP Inspector (command line, for testing)',
      'Run in a terminal; lists the tools the workspace offers.',
      [
        ...READ_TOKEN,
        `npx -y @modelcontextprotocol/inspector --cli ${shellWord(endpoint)} --transport http \\`,
        `  --header "Authorization: Bearer $${TOKEN_ENV}" --method tools/list`,
      ],
      ['Add --protocol-era modern to test the 2026-07-28 revision (the default speaks a 2025-era one).'],
    ),
  ],
};

/** Every client the Connect page offers, in display order. */
export const CLIENT_BUILDERS: readonly ClientBuilder[] = Object.freeze([
  vscode,
  jetbrains,
  copilotCli,
  claudeCode,
  cursor,
  windsurf,
  inspector,
]);

/** Clients that need OAuth (Phase 5): listed, with no snippet. */
export const OAUTH_ONLY_CLIENTS: readonly string[] = Object.freeze([
  'claude.ai on the web',
  'Claude Desktop (connectors)',
  'Claude mobile',
]);

/** All snippets for a workspace, with the token only where the client has no other way and the input carries it. */
export function clientSnippets(input: SnippetInput): Snippet[] {
  if (!isWorkspaceSlug(input.slug)) throw new TypeError('not a workspace slug');
  return CLIENT_BUILDERS.flatMap((b) => b.build(input));
}
