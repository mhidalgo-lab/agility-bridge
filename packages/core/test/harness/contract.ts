// SPDX-License-Identifier: Apache-2.0
// MCP contract (tool conventions, "Catalogue size and tools/list budget"): what a client sees in tools/list.
import { buildMcpServer, type ToolDefinition } from '../../src/index.ts';
import { makeContext } from '../helpers/context.ts';
import { rpc } from '../helpers/mcp.ts';

export const DEFAULT_CATALOGUE_MAX_TOOLS = 25;
export const DEFAULT_CATALOGUE_MAX_BYTES = 40_000;
export const FULL_CATALOGUE_MAX_BYTES = 72_000;

export interface ToolsListContract {
  readonly count: number;
  readonly bytes: number;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly annotations: unknown;
    readonly bytes: number;
  }>;
}

/** The serialised `tools/list` for these tools, as a 2025-era client receives it. */
export async function toolsListContract(tools: readonly ToolDefinition[]): Promise<ToolsListContract> {
  const result = await rpc(() => buildMcpServer({ tools, ctx: makeContext() }), 'tools/list');
  const listed = (result['tools'] as Array<Record<string, unknown>>) ?? [];
  return {
    count: listed.length,
    bytes: new TextEncoder().encode(JSON.stringify(result)).length,
    tools: listed.map((t) => ({
      name: String(t['name']),
      annotations: t['annotations'],
      bytes: new TextEncoder().encode(JSON.stringify(t)).length,
    })),
  };
}
