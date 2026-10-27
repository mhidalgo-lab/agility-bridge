// SPDX-License-Identifier: Apache-2.0
// Worst-case cost (L-114): a tool's declared `cost` must cover every Agility request one call can make, retries,
// paging and resolution included. The fake answers the worst case; the measured requests must not exceed the cost.
import { buildMcpServer, createBudget, type ToolContext, type ToolDefinition } from '../../src/index.ts';
import { rpc } from '../helpers/mcp.ts';
import type { FakeAgility } from './agility.ts';

export interface CostMeasurement {
  readonly tool: string;
  readonly declared: number;
  readonly requests: number;
  readonly withinCost: boolean;
  /** The call ended in an error result: a worst-case fixture that errors early under-measures. */
  readonly isError: boolean;
  /** The first text block of the result, to explain a failed fixture. */
  readonly text: string;
}

/** Runs one call with a budget far above the declared cost and counts the requests that reached the fake. */
export async function measureCost(
  tool: ToolDefinition,
  fake: FakeAgility,
  ctx: (overrides: Partial<ToolContext>) => ToolContext,
  args: Record<string, unknown> = {},
  /** The sibling tools a composite reads: registered with it, as the host does for a caller granted them. */
  siblings: readonly ToolDefinition[] = [],
): Promise<CostMeasurement> {
  const before = fake.requests;
  const context = ctx({ fetch: fake.fetch, budget: createBudget(Math.max(1_000, tool.cost * 10)) });
  const result = await rpc(() => buildMcpServer({ tools: [tool, ...siblings], ctx: context }), 'tools/call', {
    name: tool.name,
    arguments: args,
  });
  const requests = fake.requests - before;
  return {
    tool: tool.name,
    declared: tool.cost,
    requests,
    withinCost: requests <= tool.cost,
    isError: result['isError'] === true,
    text: ((result['content'] as Array<{ text?: string }> | undefined)?.[0]?.text ?? '').slice(0, 300),
  };
}
