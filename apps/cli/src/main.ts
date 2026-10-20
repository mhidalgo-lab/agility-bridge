// SPDX-License-Identifier: Apache-2.0
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;

/**
 * Placeholder entry point (P0-01): prints the version to stderr, because stdout is reserved for the stdio MCP channel.
 * The stdio server arrives with P1-11.
 */
export function main(writeErr: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): number {
  writeErr(`agility-bridge ${VERSION}`);
  return 0;
}
