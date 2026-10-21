// SPDX-License-Identifier: Apache-2.0
import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { ToolContext } from './context.ts';

/**
 * Tool classification (tool conventions, "Kinds and annotations"):
 * - `read`: no side effect in Agility (the only kind registered without `allowNonRead`);
 * - `write`: creates or changes something (a comment, a status);
 * - `destructive`: closes, reopens or removes something.
 */
export type ToolKind = 'read' | 'write' | 'destructive';

export type InputSchema = z.ZodObject<z.ZodRawShape>;

/** What a handler returns; the server turns it into an MCP `CallToolResult`. */
export interface ToolOutput<O = unknown> {
  /** Agent-readable summary and data block(s); Agility text inside it is enveloped by the output shaper (P1-05). */
  readonly text: string;
  /** Structured result, required when the tool declares an `outputSchema`. */
  readonly structured?: O;
  /** `_meta["agility-bridge/result"]` and friends (ADR-0015). */
  readonly meta?: Record<string, unknown>;
}

export interface ToolDefinition<I extends InputSchema = InputSchema, O = unknown> {
  /** `snake_case`, unique, stable: renaming a released tool is a breaking change. */
  readonly name: string;
  readonly title: string;
  /** Written for agents (tool conventions, "Descriptions"). */
  readonly description: string;
  readonly kind: ToolKind;
  /** Catalogue group (`core`, `query`, `work`, …); workspaces enable or disable groups (D-05). */
  readonly group: string;
  /** Worst-case Agility requests per call, retries and paging included (L-114). */
  readonly cost: number;
  readonly inputSchema: I;
  /** Open output schema (extra properties allowed, ADR-0015). */
  readonly outputSchema?: z.ZodType<O>;
  /** For `write` / `destructive` tools: repeating the same call has no further effect. Reads are always idempotent. */
  readonly idempotent?: boolean;
  readonly handler: (input: z.infer<I>, ctx: ToolContext) => Promise<ToolOutput<O>>;
}

/** Identity helper that keeps input types inferred at the definition site. */
export function defineTool<I extends InputSchema, O = unknown>(
  def: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  return def;
}

/**
 * MCP annotations derived from the kind, never written by hand (tool conventions). Every agility-bridge tool reaches
 * Agility, so `openWorldHint` is always true. Annotations are hints that most clients ignore (L-154): safety never
 * depends on them.
 */
export function annotationsFor(
  def: Pick<ToolDefinition, 'kind' | 'title'> & { readonly idempotent?: boolean | undefined },
): ToolAnnotations {
  return {
    title: def.title,
    readOnlyHint: def.kind === 'read',
    destructiveHint: def.kind === 'destructive',
    idempotentHint: def.kind === 'read' || def.idempotent === true,
    openWorldHint: true,
  };
}
