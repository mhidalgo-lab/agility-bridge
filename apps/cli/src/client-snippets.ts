// SPDX-License-Identifier: Apache-2.0
// Client setup snippets and install links for the local stdio server (P8-06, ADR-0016, L-026, L-027). One generator
// feeds the `client-config` command, the Claude Code plugin's `.mcp.json` and the docs, so they cannot drift apart
// (a test compares the committed files with this output). No snippet ever holds a token: it is a prompt or a variable the
// client expands, a placeholder to replace, or a `keychain:<name>` reference (P8-08).
import { canonicalInstanceUrl } from '@agility-bridge/core';

export const SERVER_NAME = 'agility';
export const PACKAGE_NAME = 'agility-bridge';
export const URL_PLACEHOLDER = 'https://www7.v1host.com/YourInstance';
export const TOKEN_PLACEHOLDER = '<your access token>';
export const DEFAULT_KEYCHAIN_NAME = 'agility-token';

export const CLIENTS = [
  'vscode',
  'claude-code',
  'claude-desktop',
  'cursor',
  'copilot-cli',
  'windsurf',
] as const;
export type Client = (typeof CLIENTS)[number];

export interface SnippetOptions {
  /** The instance address; a placeholder when absent. Validated and canonicalised when given. */
  readonly url?: string;
  /** Where the token comes from: a keychain entry (default for clients that store plain text) or the client's prompt. */
  readonly keychain?: string;
  /** Pin the package version (`agility-bridge@0.8.0`); unpinned runs the latest. */
  readonly version?: string;
}

export interface Snippet {
  readonly client: Client;
  /** Where the text goes. */
  readonly where: string;
  readonly format: 'json' | 'shell';
  readonly text: string;
  /** An install link, for clients that have one. */
  readonly link?: string;
  /** Things to know, one line each. */
  readonly notes: readonly string[];
}

export function instanceUrl(options: SnippetOptions): string {
  if (options.url === undefined) return URL_PLACEHOLDER;
  try {
    return canonicalInstanceUrl(options.url);
  } catch (error) {
    throw new Error(`--url: ${(error as Error).message}`);
  }
}

function pkg(options: SnippetOptions): string {
  return options.version === undefined ? PACKAGE_NAME : `${PACKAGE_NAME}@${options.version}`;
}

function keychainRef(options: SnippetOptions): string {
  return `keychain:${options.keychain ?? DEFAULT_KEYCHAIN_NAME}`;
}

/** The stdio server entry shared by every client (without the token, which differs per client). */
function entry(options: SnippetOptions, token: string, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    command: 'npx',
    args: ['-y', pkg(options)],
    env: { AB_AGILITY_URL: instanceUrl(options), AB_AGILITY_TOKEN: token },
  };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const base64 = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

const VSCODE_INPUT = {
  type: 'promptString',
  id: 'agility-token',
  description: 'Agility access token',
  password: true,
} as const;

/** The VS Code server entry: the token is a password prompt stored in VS Code's secret storage. */
function vscodeServer(options: SnippetOptions) {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a VS Code input reference, not a template
  return entry(options, '${input:agility-token}', { type: 'stdio' });
}

/** `vscode:mcp/install?<json>` (VS Code) and its web redirect; the JSON carries the entry and the input prompt. */
export function vscodeInstallLinks(options: SnippetOptions): { readonly uri: string; readonly web: string } {
  const config = { name: SERVER_NAME, ...vscodeServer(options), inputs: [VSCODE_INPUT] };
  const encoded = encodeURIComponent(JSON.stringify(config));
  return {
    uri: `vscode:mcp/install?${encoded}`,
    web: `https://insiders.vscode.dev/redirect/mcp/install?name=${SERVER_NAME}&inputs=${encodeURIComponent(
      JSON.stringify([VSCODE_INPUT]),
    )}&config=${encodeURIComponent(JSON.stringify(vscodeServer(options)))}`,
  };
}

/** `cursor://anysphere.cursor-deeplink/mcp/install?name=…&config=<base64>`: the entry with a token placeholder. */
export function cursorInstallLink(options: SnippetOptions): string {
  const config = entry(options, options.keychain === undefined ? TOKEN_PLACEHOLDER : keychainRef(options));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${encodeURIComponent(base64(JSON.stringify(config)))}`;
}

export function snippet(client: Client, options: SnippetOptions = {}): Snippet {
  const token = keychainRef(options);
  const keychainNote = `The token stays in your OS keychain: store it once with \`agility-bridge keychain set ${options.keychain ?? DEFAULT_KEYCHAIN_NAME}\` (docs/guide/secrets.md).`;
  const restart = 'Restart or reconnect the server after upgrading: clients cache the tool list (L-027).';
  switch (client) {
    case 'vscode': {
      const links = vscodeInstallLinks(options);
      return {
        client,
        where: '.vscode/mcp.json in the workspace, or "MCP: Open User Configuration" for every workspace',
        format: 'json',
        text: json({ inputs: [VSCODE_INPUT], servers: { [SERVER_NAME]: vscodeServer(options) } }),
        link: links.uri,
        notes: [
          'VS Code asks for the token once and keeps it in its secret storage, out of the file.',
          `Web link that opens VS Code: ${links.web}`,
          restart,
        ],
      };
    }
    case 'claude-code': {
      const url = instanceUrl(options);
      return {
        client,
        where:
          'your shell; this stores the entry in ~/.claude.json (use --scope project to write .mcp.json instead)',
        format: 'shell',
        text: `claude mcp add ${SERVER_NAME} --scope user -e AB_AGILITY_URL=${url} -e AB_AGILITY_TOKEN=${token} -- npx -y ${pkg(options)}\n`,
        notes: [
          keychainNote,
          'Check with /mcp inside Claude Code. The Claude Code plugin (plugins/agility-bridge) does the same with prompts.',
          restart,
        ],
      };
    }
    case 'claude-desktop':
      return {
        client,
        where: 'Settings > Developer > Edit Config (claude_desktop_config.json)',
        format: 'json',
        text: json({ mcpServers: { [SERVER_NAME]: entry(options, token) } }),
        notes: [
          keychainNote,
          'Restart Claude Desktop. On Windows Node 24 must be installed on Windows itself.',
          restart,
        ],
      };
    case 'cursor':
      return {
        client,
        where: '~/.cursor/mcp.json, or .cursor/mcp.json in a project',
        format: 'json',
        text: json({ mcpServers: { [SERVER_NAME]: entry(options, token) } }),
        link: cursorInstallLink(options),
        notes: [keychainNote, 'Cursor shows at most 40 tools across all servers.', restart],
      };
    case 'copilot-cli':
      return {
        client,
        where: '~/.copilot/mcp-config.json',
        format: 'json',
        text: json({
          mcpServers: { [SERVER_NAME]: { type: 'local', ...entry(options, token), tools: ['*'] } },
        }),
        notes: [keychainNote, restart],
      };
    case 'windsurf':
      return {
        client,
        where: '~/.config/devin/mcp_config.json (formerly ~/.codeium/windsurf/mcp_config.json)',
        format: 'json',
        text: json({ mcpServers: { [SERVER_NAME]: entry(options, token) } }),
        notes: [keychainNote, restart],
      };
  }
}

export { pluginMcpJson } from './plugin-mcp.ts';
