// SPDX-License-Identifier: Apache-2.0
// MCP contract (tool conventions, "Catalogue size and tools/list budget"): what a client sees in tools/list.
import { buildMcpServer, type ToolDefinition } from '../../src/index.ts';
import { makeContext } from '../helpers/context.ts';
import { rpc } from '../helpers/mcp.ts';

export const DEFAULT_CATALOGUE_MAX_TOOLS = 25;
export const DEFAULT_CATALOGUE_MAX_BYTES = 40_000;
export const FULL_CATALOGUE_MAX_BYTES = 72_000;
/**
 * A tripwire below the cap (P6-12, D-116): the default catalogue was 39.2 of 40 KB; the consistency pass left it at about
 * 35.9 KB; `get_velocity` (P6-17, D-140) raised the target to 37.6 KB. A change that crosses this says why instead of eating the headroom one tool at a time.
 */
export const DEFAULT_CATALOGUE_TARGET_BYTES = 37_600;
/** One tool's entry in `tools/list` (description, input and output schema); the generic `query_assets` is the largest. */
export const TOOL_MAX_BYTES = 4_000;
/** Groups a workspace must switch on (docs/reference/tool-catalogue.md): not part of the default catalogue. */
export const OPT_IN_GROUPS: readonly string[] = ['attachments', 'reports', 'writes'];

/** The tools a workspace gets without switching on an opt-in group. */
export const defaultCatalogue = (tools: readonly ToolDefinition[]): ToolDefinition[] =>
  tools.filter((t) => !OPT_IN_GROUPS.includes(t.group));

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
