// SPDX-License-Identifier: Apache-2.0
import pkg from '../package.json' with { type: 'json' };
import { ConfigError, loadConfig } from './config.ts';
import { startServe } from './serve.ts';
import { startStdio } from './stdio.ts';

export const VERSION: string = pkg.version;

export const HELP = `agility-bridge ${VERSION}: an unofficial MCP server for Digital.ai Agility

Usage:
  agility-bridge [stdio]      Serve MCP on stdin/stdout (the default; started by your MCP client)
  agility-bridge serve        Serve workspaces over HTTP at /w/<slug>/mcp (a team server; needs a master key)
  agility-bridge --version    Print the version
  agility-bridge --help       Print this help

Configuration comes from the environment your MCP client sets, never from flags:
  AB_AGILITY_URL, AB_AGILITY_TOKEN   the instance and the member's access token
  AB_CONFIG, AB_WORKSPACE            or a YAML file and the workspace to serve from it
See https://github.com/mhidalgo-lab/agility-bridge/blob/main/docs/guide/configuration.md
and, for serve, docs/guide/secrets.md and docs/guide/access-model.md.`;

export interface Io {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Human output (help, version): only outside stdio mode. */
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** Flags that look like secrets are refused with an explanation (L-026, T23). */
const SECRET_FLAG = /^--?(?:token|agility[-_]?token|password|secret|api[-_]?key|master[-_]?key)\b/i;

/** Starts the HTTP server; resolves to `serving`, or an exit code when the configuration is refused. */
async function serve(io: Io): Promise<number | 'serving'> {
  try {
    const server = await startServe(io.env);
    const stop = () => {
      server.close().finally(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return 'serving';
  } catch (error) {
    if (error instanceof ConfigError) {
      io.err(`agility-bridge: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

/** Runs the CLI. Returns an exit code, or `serving` when a server is running (asynchronously for `serve`). */
export function main(args: readonly string[], io: Io): number | 'serving' | Promise<number | 'serving'> {
  const [command, ...rest] = args;
  if (command === '--version' || command === '-v') {
    io.out(`agility-bridge ${VERSION}`);
    return 0;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    io.out(HELP);
    return 0;
  }
  const secret = args.find((a) => SECRET_FLAG.test(a));
  if (secret !== undefined) {
    io.err(
      'agility-bridge never takes secrets as flags (they leak through process listings). Set AB_AGILITY_TOKEN in the env block of your MCP client instead.',
    );
    return 2;
  }
  if (command === 'serve' && rest.length === 0) return serve(io);
  if ((command !== undefined && command !== 'stdio') || rest.length > 0) {
    io.err(`Unknown argument: ${(command !== 'stdio' ? command : rest[0])?.slice(0, 40)}\n\n${HELP}`);
    return 2;
  }
  try {
    startStdio(loadConfig(io.env, { warn: (m) => io.err(`agility-bridge: ${m}`) }), { env: io.env });
    return 'serving';
  } catch (error) {
    if (error instanceof ConfigError) {
      io.err(`agility-bridge: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
