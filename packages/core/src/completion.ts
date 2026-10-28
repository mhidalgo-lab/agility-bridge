// SPDX-License-Identifier: Apache-2.0
// Prompt argument completion (P6-32, L-305): `completion/complete` for the `team`, `project` and `sprint` arguments of the
// prompts that are available, answered through the existing list tools' handlers, so the workspace's project scope, asset
// type rules, budget and shaping apply exactly as for a call. Offered only when the list tool is granted too. Every value
// is Agility text: it is dropped unless the prompt's own argument schema accepts it (plain text on one line), so a
// completion can never carry anything a caller could not have typed.
import { completable } from '@modelcontextprotocol/server';
import type { ZodType } from 'zod';
import { freezeContext, type ToolContext } from './context.ts';
import type { PromptDefinition } from './prompts.ts';
import type { ToolDefinition, ToolOutput } from './tool.ts';

/** Most values one completion returns. */
export const MAX_COMPLETIONS = 20;

interface Source {
  /** The list tool whose rows are the candidates. */
  readonly tool: string;
  /** Its arguments for what the user has typed so far. */
  readonly input: (typed: string) => Record<string, unknown>;
  /** Fixed words the argument also accepts, offered first. */
  readonly words?: readonly string[];
}

/** Argument name -> where its candidates come from. One list call per completion: its declared cost bounds it. */
export const COMPLETION_SOURCES: Readonly<Record<string, Source>> = Object.freeze({
  team: { tool: 'list_teams', input: (typed) => ({ limit: MAX_COMPLETIONS, ...contains(typed) }) },
  project: { tool: 'list_projects', input: (typed) => ({ limit: MAX_COMPLETIONS, ...contains(typed) }) },
  sprint: {
    tool: 'list_sprints',
    input: () => ({ limit: 100 }),
    words: Object.freeze(['current', 'previous', 'next']),
  },
});

const contains = (typed: string): Record<string, unknown> => (typed === '' ? {} : { contains: typed });

export interface CompletionHost {
  readonly tools: readonly ToolDefinition[];
  readonly contextFor: () => ToolContext;
  readonly onToolCall?: ((event: CompletionEvent) => void) | undefined;
}

/** What a host observes about a completion (the same facts as a tool call). */
export interface CompletionEvent {
  readonly tool: string;
  readonly status: 'ok' | 'error';
  readonly out?: ToolOutput;
  readonly requestsUsed: number;
}

/** The names of one list result's rows. */
function namesOf(out: ToolOutput): string[] {
  const items = (out.structured as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((row) => {
    const name = (row as { name?: unknown } | null)?.name;
    return typeof name === 'string' ? [name] : [];
  });
}

/**
 * The prompt's argument shape with its completable arguments wrapped. The shape is the SDK's discovery hook; the schemas
 * are fresh objects (a completer closes over this request's context) and validate exactly as the originals.
 */
export function completionShape(
  def: PromptDefinition,
  host: CompletionHost,
): Record<string, ZodType> | undefined {
  const shape = def.arguments.shape as Record<string, ZodType>;
  const out: Record<string, ZodType> = { ...shape };
  let any = false;
  for (const [name, field] of Object.entries(shape)) {
    const source = COMPLETION_SOURCES[name];
    const tool = source === undefined ? undefined : host.tools.find((t) => t.name === source.tool);
    if (source === undefined || tool === undefined) continue;
    any = true;
    const inner = Object.create(unwrapOptional(field)) as ZodType;
    const complete = completable(
      inner as never,
      (async (typed: string) => candidates(def, name, source, tool, host, typed)) as never,
    );
    out[name] = Object.assign(Object.create(field), {
      type: 'optional',
      def: { ...(field as unknown as { def: object }).def, innerType: complete },
    }) as ZodType;
  }
  return any ? out : undefined;
}

const unwrapOptional = (field: ZodType): ZodType =>
  (field as unknown as { type?: string }).type === 'optional'
    ? ((field as unknown as { def: { innerType: ZodType } }).def.innerType ?? field)
    : field;

async function candidates(
  def: PromptDefinition,
  name: string,
  source: Source,
  tool: ToolDefinition,
  host: CompletionHost,
  typedRaw: string,
): Promise<string[]> {
  const typed = typeof typedRaw === 'string' ? typedRaw.slice(0, 200) : '';
  const accepts = (value: string): boolean => (def.arguments.shape[name] as ZodType).safeParse(value).success;
  const needle = typed.toLowerCase();
  const words = (source.words ?? []).filter((w) => w.startsWith(needle));
  const ctx = freezeContext({ ...host.contextFor(), grantedTools: host.tools.map((t) => t.name) });
  let names: string[] = [];
  let out: ToolOutput | undefined;
  try {
    const parsed = tool.inputSchema.safeParse(source.input(typed));
    if (parsed.success) {
      out = await tool.handler(parsed.data, ctx);
      names = namesOf(out);
    }
    host.onToolCall?.({
      tool: `completion:${def.id}.${name}`,
      status: 'ok',
      ...(out ? { out } : {}),
      requestsUsed: ctx.budget.used,
    });
  } catch {
    // Denied, over budget or upstream trouble: no suggestions, and no error text (it may carry Agility text).
    host.onToolCall?.({
      tool: `completion:${def.id}.${name}`,
      status: 'error',
      requestsUsed: ctx.budget.used,
    });
    return words.filter(accepts);
  }
  // The sprint list has no text filter: match here.
  const matching = names.filter((n) => needle === '' || n.toLowerCase().includes(needle));
  return [...new Set([...words, ...matching])].filter(accepts).slice(0, MAX_COMPLETIONS);
}
