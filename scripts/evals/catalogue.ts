// SPDX-License-Identifier: Apache-2.0
// P6-10: the tools exactly as an agent sees them in `tools/list` (name, description, input schema), for the router
// baseline and the LLM eval (L-124). Derived from the registry the same way the server advertises it.
import { CORE_TOOLS, type ToolDefinition, withCachedJsonSchema } from '../../packages/core/src/index.ts';

/** Groups a workspace must switch on; mirrors `OPT_IN_GROUPS` in the core test harness (a test keeps them equal). */
export const OPT_IN_GROUPS: readonly string[] = ['attachments', 'reports', 'writes'];

export interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly group: string;
  readonly inputSchema: Record<string, unknown>;
}

export type CatalogueKind = 'default' | 'full';

function listed(tool: ToolDefinition): ListedTool {
  const inputSchema = withCachedJsonSchema(tool.inputSchema as never)['~standard'].jsonSchema.input({
    target: 'draft-2020-12',
  }) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, group: tool.group, inputSchema };
}

/** `default`: what a workspace gets without opt-in groups; `full`: every tool (attachments, reports, ...). */
export function listedTools(
  kind: CatalogueKind,
  tools: readonly ToolDefinition[] = CORE_TOOLS,
): ListedTool[] {
  return tools.filter((t) => kind === 'full' || !OPT_IN_GROUPS.includes(t.group)).map(listed);
}
