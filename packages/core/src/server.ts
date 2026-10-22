// SPDX-License-Identifier: Apache-2.0
import { type CallToolResult, McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { freezeContext, type ToolContext } from './context.ts';
import { ERROR_META_KEY, type ToolErrorOptions, toToolErrorResult } from './errors.ts';
import { envelopeRenderer, newEnvelopeId } from './output/envelope.ts';
import { annotationsFor, type ToolDefinition, type ToolOutput } from './tool.ts';
import { VERSION } from './version.ts';

export interface ServerInfo {
  readonly name: string;
  readonly version: string;
}

export const DEFAULT_SERVER_INFO: ServerInfo = Object.freeze({ name: 'agility-bridge', version: VERSION });

/** What one finished tool call looks like to an observer (audit, P2-08). Holds no result rows. */
export interface ToolCallEvent {
  readonly tool: string;
  readonly status: 'ok' | 'error';
  readonly errorCode: string | null;
  readonly durationMs: number;
  readonly requestsUsed: number;
  /** Asset numbers in the result (`B-01234`, at most 50): identifiers, never content (audit, P2-08). */
  readonly assetNumbers: readonly string[];
  /** The compiled Agility queries with every bound value masked (at most 10, each at most 2,000 characters). */
  readonly queries: readonly string[];
}

const ASSET_NUMBER = /^[A-Za-z]{1,4}-\d{1,12}$/;
const MAX_AUDIT_NUMBERS = 50;
const MAX_AUDIT_QUERIES = 10;
const MAX_QUERY_CHARS = 2_000;

/** The audit facts of a tool result: asset numbers from its rows and the masked queries from its `_meta`. */
export function auditFacts(out: ToolOutput | undefined): { assetNumbers: string[]; queries: string[] } {
  const numbers = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (numbers.size >= MAX_AUDIT_NUMBERS || depth > 5 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      if (
        k === 'number' &&
        typeof v === 'string' &&
        ASSET_NUMBER.test(v) &&
        numbers.size < MAX_AUDIT_NUMBERS
      ) {
        numbers.add(v.toUpperCase());
      } else {
        walk(v, depth + 1);
      }
    }
  };
  walk(out?.structured, 0);
  const result = out?.meta?.['agility-bridge/result'] as { query?: unknown; queries?: unknown } | undefined;
  const raw = [result?.query, ...(Array.isArray(result?.queries) ? result.queries : [])].filter(
    (q) => q !== undefined,
  );
  const queries = raw.slice(0, MAX_AUDIT_QUERIES).map((q) => {
    const text = typeof q === 'string' ? q : JSON.stringify(q);
    return text.length > MAX_QUERY_CHARS ? `${text.slice(0, MAX_QUERY_CHARS)}…` : text;
  });
  return { assetNumbers: [...numbers], queries };
}

export interface BuildServerOptions {
  /** Tools this caller may use, already filtered (`ToolRegistry.select`). Only these are registered. */
  readonly tools: readonly ToolDefinition[];
  /**
   * The request context, or a factory called once per tool call. HTTP builds one server per request and passes the
   * context; stdio keeps one server per connection and passes a factory, so every call gets a fresh request id and
   * budget (ADR-0010, T21).
   */
  readonly ctx: ToolContext | (() => ToolContext);
  readonly info?: ServerInfo;
  /**
   * Advertise `tools.listChanged` (default false). A per-request HTTP server never pushes a change, so it must not
   * promise one (ADR-0005, L-016); stdio may pass true.
   */
  readonly listChanged?: boolean;
  /** How error details that may contain Agility text are shown. Default: the untrusted-data envelope (P1-05). */
  readonly errors?: ToolErrorOptions;
  /** Called after every tool call. Must not throw; a throw is swallowed. */
  readonly onToolCall?: (event: ToolCallEvent) => void;
}

type JsonSchemaOptions = Parameters<StandardSchemaWithJSON['~standard']['jsonSchema']['input']>[0];

/**
 * Per-process memo of tool schemas wrapped so their JSON Schema is computed once (L-020; P0-07 measured the SDK
 * converting zod on every `tools/list` at 4.9 ms for 25 tools against 0.7 ms cached). Tool schemas are static
 * definitions, never request data, so caching them per process is allowed (T21). Keyed by the schema object.
 */
const cachedSchemas = new WeakMap<object, StandardSchemaWithJSON>();

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Drops `$schema` (2020-12 is the MCP default) and, for outputs, `additionalProperties: false` (open schemas). */
function advertised(schema: Record<string, unknown>, io: 'input' | 'output'): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = schema;
  return io === 'output' ? (openSchema(rest) as Record<string, unknown>) : rest;
}

function openSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(openSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties' && v === false) continue;
    out[k] = openSchema(v);
  }
  return out;
}

/** The JSON Schema draft the MCP SDK asks tool schemas for (`JSON_SCHEMA_CONVERSION_TARGET` in SDK 2.x). */
const SDK_SCHEMA_TARGET = 'draft-2020-12';

/**
 * Converts every tool's schemas now, into the cache `tools/list` reads (L-020). Workers call it at module scope, so the
 * first request of an isolate does not pay for the conversion (P3-14).
 */
export function prewarmToolSchemas(tools: readonly ToolDefinition[]): void {
  for (const def of tools) {
    withCachedJsonSchema(def.inputSchema)['~standard'].jsonSchema.input({ target: SDK_SCHEMA_TARGET });
    if (def.outputSchema !== undefined) {
      withCachedJsonSchema(def.outputSchema)['~standard'].jsonSchema.output({ target: SDK_SCHEMA_TARGET });
    }
  }
}

/** The same schema (validation unchanged) whose `~standard.jsonSchema` answers from the per-process cache. */
export function withCachedJsonSchema(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  const hit = cachedSchemas.get(schema);
  if (hit !== undefined) return hit;
  const std = schema['~standard'];
  const memo = new Map<string, Record<string, unknown>>();
  const convert =
    (io: 'input' | 'output') =>
    (options: JsonSchemaOptions): Record<string, unknown> => {
      const key = `${io}:${options.target}:${JSON.stringify(options.libraryOptions ?? null)}`;
      let json = memo.get(key);
      if (json === undefined) {
        // Frozen: the same object is handed to every request, so nobody may change it.
        json = deepFreeze(advertised(std.jsonSchema[io](options), io));
        memo.set(key, json);
      }
      return json;
    };
  const wrapped: StandardSchemaWithJSON = {
    '~standard': {
      version: std.version,
      vendor: std.vendor,
      validate: (value, options) => std.validate(value, options),
      ...(std.types === undefined ? {} : { types: std.types }),
      jsonSchema: { input: convert('input'), output: convert('output') },
    },
  };
  cachedSchemas.set(schema, wrapped);
  return wrapped;
}

/** The MCP result for a handler's output. */
export function toCallToolResult(out: ToolOutput): CallToolResult {
  return {
    content: [{ type: 'text', text: out.text }],
    ...(out.structured === undefined ? {} : { structuredContent: out.structured as Record<string, unknown> }),
    ...(out.meta === undefined ? {} : { _meta: out.meta }),
  };
}

/**
 * Build an MCP server for one request (ADR-0005: stateless, one server per request) or one stdio connection.
 * Tools not in `tools` are not registered, so they are neither listed nor callable. Prompts and resources arrive with
 * P6-08 and P6-09 and follow the same rule (only those whose tools are allowed).
 */
export function buildMcpServer({
  tools,
  ctx: context,
  info = DEFAULT_SERVER_INFO,
  listChanged = false,
  errors,
  onToolCall,
}: BuildServerOptions): McpServer {
  const server = new McpServer(
    { name: info.name, version: info.version },
    { capabilities: { tools: { listChanged } } },
  );
  const contextFor = typeof context === 'function' ? context : () => context;
  for (const def of tools) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: withCachedJsonSchema(def.inputSchema),
        annotations: annotationsFor(def),
        ...(def.outputSchema ? { outputSchema: withCachedJsonSchema(def.outputSchema) } : {}),
      },
      async (input: unknown): Promise<CallToolResult> => {
        const ctx = freezeContext(contextFor());
        const logger = ctx.logger.child({ requestId: ctx.requestId, tool: def.name });
        const started = ctx.clock.now();
        const observe = (status: 'ok' | 'error', errorCode: string | null, out?: ToolOutput): void => {
          try {
            if (onToolCall === undefined) return;
            onToolCall({
              tool: def.name,
              status,
              errorCode,
              durationMs: Math.max(0, ctx.clock.now() - started),
              requestsUsed: ctx.budget.used,
              ...auditFacts(out),
            });
          } catch {
            // An observer never changes a tool result.
          }
        };
        try {
          const out = await def.handler(input as never, ctx);
          logger.debug('tool ok', { ms: ctx.clock.now() - started, requests: ctx.budget.used });
          observe('ok', null, out);
          return toCallToolResult(out);
        } catch (error) {
          const result = toToolErrorResult(
            error,
            ctx.requestId,
            errors ?? { renderUntrusted: envelopeRenderer(newEnvelopeId(ctx.random)) },
          );
          const code = (result._meta?.[ERROR_META_KEY] as { code?: string } | undefined)?.code ?? null;
          logger.warn('tool error', { ms: ctx.clock.now() - started, code, error });
          observe('error', code);
          return result;
        }
      },
    );
  }
  return server;
}
