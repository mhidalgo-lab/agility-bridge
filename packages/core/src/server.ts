// SPDX-License-Identifier: Apache-2.0
import {
  type CallToolResult,
  McpServer,
  type ReadResourceResult,
  ResourceTemplate,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { type CompletionEvent, completionShape } from './completion.ts';
import { freezeContext, type ToolContext } from './context.ts';
import {
  AbError,
  ERROR_META_KEY,
  ErrorCode,
  isAbError,
  type ToolErrorOptions,
  toProtocolError,
  toToolErrorResult,
} from './errors.ts';
import { availableEntries } from './manifest.ts';
import { envelopeRenderer, newEnvelopeId } from './output/envelope.ts';
import { PROMPT_MANIFEST, type PromptDefinition } from './prompts.ts';
import { isTemplate, RESOURCE_MANIFEST, type ResourceDefinition, type ResourceReader } from './resources.ts';
import { annotationsFor, type ToolDefinition, type ToolOutput } from './tool.ts';
import { VERSION } from './version.ts';

export interface ServerInfo {
  readonly name: string;
  readonly version: string;
}

export const DEFAULT_SERVER_INFO: ServerInfo = Object.freeze({ name: 'agility-bridge', version: VERSION });

/** What one finished tool call looks like to an observer (audit, P2-08). Holds no result rows. */
export interface ToolCallEvent {
  /** The tool name, or `resource:<manifest id>` for a resource read (P6-09). */
  readonly tool: string;
  readonly status: 'ok' | 'error';
  readonly errorCode: string | null;
  readonly durationMs: number;
  readonly requestsUsed: number;
  /** Asset numbers in the result (`B-01234`, at most 50): identifiers, never content (audit, P2-08). */
  readonly assetNumbers: readonly string[];
  /** The compiled Agility queries with every bound value masked (at most 10, each at most 2,000 characters). */
  readonly queries: readonly string[];
  /** A downloaded attachment: asset number, attachment id, size and content type (never content; THREAT_MODEL A8). */
  readonly download?: {
    readonly asset: string;
    readonly attachment: string;
    readonly bytes: number;
    readonly contentType: string;
  };
}

const ASSET_NUMBER = /^[A-Za-z]{1,4}-\d{1,12}$/;
const MAX_AUDIT_NUMBERS = 50;
const MAX_AUDIT_QUERIES = 10;
const MAX_QUERY_CHARS = 2_000;

/** The download facts of a result's `_meta` or of a failed call's `AbError.audit`, bounded; undefined when malformed. */
export function downloadFacts(value: unknown): NonNullable<ToolCallEvent['download']> | undefined {
  const d = value as Record<string, unknown> | null | undefined;
  if (d === null || d === undefined || typeof d !== 'object') return undefined;
  return typeof d['asset'] === 'string' &&
    typeof d['attachment'] === 'string' &&
    typeof d['bytes'] === 'number' &&
    typeof d['contentType'] === 'string'
    ? {
        asset: d['asset'].slice(0, 64),
        attachment: d['attachment'].slice(0, 64),
        bytes: d['bytes'],
        contentType: d['contentType'].slice(0, 100),
      }
    : undefined;
}

/** The audit facts of a tool result: asset numbers from its rows and the masked queries from its `_meta`. */
export function auditFacts(out: ToolOutput | undefined): {
  assetNumbers: string[];
  queries: string[];
  download?: NonNullable<ToolCallEvent['download']>;
} {
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
  const download = downloadFacts(out?.meta?.['agility-bridge/download']);
  return { assetNumbers: [...numbers], queries, ...(download === undefined ? {} : { download }) };
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
   * The resource manifest to serve (default: `RESOURCE_MANIFEST`). Only entries whose tools are all in `tools` are
   * registered, so a resource exists exactly when the tools it is served through are allowed (L-153).
   */
  readonly resources?: readonly ResourceDefinition[];
  /**
   * The prompt manifest to serve (default: `PROMPT_MANIFEST`), filtered exactly like the resources (L-153): a prompt
   * exists only when every tool it tells the model to call is in `tools`. A prompt never calls Agility itself.
   */
  readonly prompts?: readonly PromptDefinition[];
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

/** Drops `$schema` (2020-12 is the MCP default) and, for outputs, `additionalProperties` that only says "open" (`false`, `{}`). */
function advertised(schema: Record<string, unknown>, io: 'input' | 'output'): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = schema;
  return io === 'output' ? (openSchema(rest) as Record<string, unknown>) : rest;
}

function openSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(openSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    // Open is the JSON Schema default: `false` (closed) is refused and `{}` (zod's loose object) says nothing.
    if (
      k === 'additionalProperties' &&
      (v === false || (typeof v === 'object' && v !== null && Object.keys(v).length === 0))
    )
      continue;
    out[k] = openSchema(v);
  }
  return out;
}

/** The JSON Schema draft the MCP SDK asks tool schemas for (`JSON_SCHEMA_CONVERSION_TARGET` in SDK 2.x). */
const SDK_SCHEMA_TARGET = 'draft-2020-12';

/**
 * Converts every tool's (and prompt's) schemas now, into the cache `tools/list` reads (L-020). Workers call it at module scope, so the
 * first request of an isolate does not pay for the conversion (P3-14).
 */
export function prewarmToolSchemas(tools: readonly ToolDefinition[]): void {
  for (const def of tools) {
    withCachedJsonSchema(def.inputSchema)['~standard'].jsonSchema.input({ target: SDK_SCHEMA_TARGET });
    if (def.outputSchema !== undefined) {
      withCachedJsonSchema(def.outputSchema)['~standard'].jsonSchema.output({ target: SDK_SCHEMA_TARGET });
    }
  }
  // The prompts' argument schemas too: the first `prompts/list` cost 75 ms of CPU cold (P6-39).
  for (const prompt of PROMPT_MANIFEST) {
    withCachedJsonSchema(prompt.arguments)['~standard'].jsonSchema.input({ target: SDK_SCHEMA_TARGET });
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

/**
 * The same schema, advertised unchanged, whose validation lets everything through: the SDK would answer a refused
 * argument with a plain "Input validation error" without a code (P6-37). The handler wrapper validates instead and
 * answers `AB_INPUT_INVALID` like every other refused input.
 */
function deferValidation(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  const std = schema['~standard'];
  return {
    '~standard': { ...std, validate: (value: unknown) => ({ value }) },
  } as StandardSchemaWithJSON;
}

const MAX_ISSUE_TEXT = 120;
const clip = (text: string): string =>
  text.length > MAX_ISSUE_TEXT ? `${text.slice(0, MAX_ISSUE_TEXT)}...` : text;

/** Validates a call's arguments with the tool's schema; a refusal is `AB_INPUT_INVALID` naming the argument path. */
function parseInput(def: ToolDefinition, input: unknown, used: string[]): never {
  let raw = input ?? {};
  // Deprecated aliases (one release): the new name wins when both are given.
  if (def.deprecatedArguments !== undefined && typeof raw === 'object' && !Array.isArray(raw)) {
    const mapped: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    for (const [old, replacement] of Object.entries(def.deprecatedArguments)) {
      if (!(old in mapped)) continue;
      used.push(old);
      if (mapped[replacement] === undefined) mapped[replacement] = mapped[old];
      delete mapped[old];
    }
    raw = mapped;
  }
  const parsed = def.inputSchema.safeParse(raw);
  if (parsed.success) return parsed.data as never;
  const issue = parsed.error.issues[0];
  const path = (issue?.path ?? []).map(String).join('.');
  const where = path === '' ? 'the arguments' : `argument "${clip(path)}"`;
  throw new AbError(
    ErrorCode.InputInvalid,
    `Invalid ${where} for ${def.name}: ${clip(issue?.message ?? 'does not match the input schema')}.`,
    {
      hint: `Check the argument against the input schema of ${def.name} (types, allowed values, minimum and maximum).`,
    },
  );
}

const warned = new Set<string>();
/** One warning per process and deprecated argument (tool names and fixed words only, never request data). */
function warnOnce(logger: ToolContext['logger'], tool: string, argument: string): void {
  const key = `${tool}.${argument}`;
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn('deprecated argument used', { tool, argument });
}

/** Adds one fixed note per deprecated argument the call used, to the text and to `structuredContent.notes`. */
function withDeprecationNotes(
  def: ToolDefinition,
  used: readonly string[],
  out: ToolOutput,
  warn: (argument: string) => void,
): ToolOutput {
  if (used.length === 0) return out;
  const notes = used.map((old) => {
    warn(old);
    return `Argument ${old} is deprecated; use ${def.deprecatedArguments?.[old]}. It is removed in a later release.`;
  });
  const structured =
    out.structured !== null && typeof out.structured === 'object'
      ? {
          ...(out.structured as Record<string, unknown>),
          notes: [
            ...(((out.structured as { notes?: unknown }).notes as string[] | undefined) ?? []),
            ...notes,
          ],
        }
      : out.structured;
  return {
    ...out,
    text: `${out.text}\n${notes.map((n) => `Note: ${n}`).join('\n')}`,
    ...(structured === undefined ? {} : { structured }),
  };
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
  resources = RESOURCE_MANIFEST,
  prompts = PROMPT_MANIFEST,
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
        inputSchema: deferValidation(withCachedJsonSchema(def.inputSchema)),
        annotations: annotationsFor(def),
        ...(def.outputSchema ? { outputSchema: withCachedJsonSchema(def.outputSchema) } : {}),
      },
      async (input: unknown): Promise<CallToolResult> => {
        const ctx = freezeContext({ ...contextFor(), grantedTools: tools.map((t) => t.name) });
        const logger = ctx.logger.child({ requestId: ctx.requestId, tool: def.name });
        const started = ctx.clock.now();
        const observe = (
          status: 'ok' | 'error',
          errorCode: string | null,
          out?: ToolOutput,
          failedDownload?: ToolCallEvent['download'],
        ): void => {
          try {
            if (onToolCall === undefined) return;
            onToolCall({
              tool: def.name,
              status,
              errorCode,
              durationMs: Math.max(0, ctx.clock.now() - started),
              requestsUsed: ctx.budget.used,
              ...auditFacts(out),
              ...(failedDownload === undefined ? {} : { download: failedDownload }),
            });
          } catch {
            // An observer never changes a tool result.
          }
        };
        try {
          const aliases: string[] = [];
          const out = withDeprecationNotes(
            def,
            aliases,
            await def.handler(parseInput(def, input, aliases), ctx),
            (name) => warnOnce(logger, def.name, name),
          );
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
          observe('error', code, undefined, isAbError(error) ? downloadFacts(error.audit) : undefined);
          return result;
        }
      },
    );
  }
  registerResources(server, {
    tools,
    resources: availableEntries(
      resources,
      tools.map((t) => t.name),
    ),
    contextFor,
    onToolCall,
  });
  for (const def of availableEntries(
    prompts,
    tools.map((t) => t.name),
  )) {
    registerPrompt(server, def, { tools, contextFor, onToolCall });
  }
  return server;
}

/** Registers one available prompt: arguments validated by its schema, then its static text built from them. */
function registerPrompt(
  server: McpServer,
  def: PromptDefinition,
  host: {
    readonly tools: readonly ToolDefinition[];
    readonly contextFor: () => ToolContext;
    readonly onToolCall: BuildServerOptions['onToolCall'];
  },
): void {
  // Completion (P6-32): the same schema with the completable arguments discoverable by the SDK.
  const shape = completionShape(def, {
    tools: host.tools,
    contextFor: host.contextFor,
    onToolCall: (event: CompletionEvent) => {
      try {
        host.onToolCall?.({
          tool: event.tool,
          status: event.status,
          errorCode: null,
          durationMs: 0,
          requestsUsed: event.requestsUsed,
          ...auditFacts(event.out),
        });
      } catch {
        // An observer never changes a completion.
      }
    },
  });
  server.registerPrompt(
    def.id,
    {
      title: def.title,
      description: def.description,
      argsSchema: {
        ...withCachedJsonSchema(def.arguments),
        ...(shape === undefined ? {} : { shape }),
      } as never,
    },
    ((args: Record<string, string | undefined>) => {
      let text: string;
      try {
        text = def.build(args);
      } catch (error) {
        throw toProtocolError(
          new AbError(ErrorCode.InputInvalid, error instanceof Error ? error.message : 'Invalid arguments.'),
        );
      }
      return {
        description: def.title,
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
      };
    }) as never,
  );
}

interface ResourceRegistration {
  readonly tools: readonly ToolDefinition[];
  readonly resources: readonly ResourceDefinition[];
  readonly contextFor: () => ToolContext;
  readonly onToolCall: ((event: ToolCallEvent) => void) | undefined;
}

/**
 * Registers the manifest's available resources. A read builds a fresh request context, runs the declared tools'
 * handlers through the reader (same budget, limits, cache and shaping as a tool call) and is observed like one.
 * Prompts (P6-08) register the same way from the same manifest module.
 */
function registerResources(server: McpServer, reg: ResourceRegistration): void {
  const byName = new Map(reg.tools.map((t) => [t.name, t] as const));
  /** One fresh context per read or list; `run` is limited to the entry's declared tools. */
  const readerFor = (def: ResourceDefinition): ResourceReader => {
    const ctx = freezeContext(reg.contextFor());
    return {
      ctx,
      run: async (name, input = {}) => {
        const tool = def.uses.includes(name) ? byName.get(name) : undefined;
        if (tool === undefined) {
          throw new AbError(ErrorCode.NotFound, `Resource ${def.id} cannot use ${name}.`);
        }
        const parsed = tool.inputSchema.safeParse(input);
        if (!parsed.success) {
          throw new AbError(ErrorCode.InputInvalid, `The resource address is not valid for ${def.id}.`);
        }
        return tool.handler(parsed.data, ctx);
      },
    };
  };
  const observe = (
    def: ResourceDefinition,
    reader: ResourceReader,
    started: number,
    outcome: { error: unknown } | { out?: ToolOutput },
  ): void => {
    try {
      if (reg.onToolCall === undefined) return;
      const failed = 'error' in outcome;
      reg.onToolCall({
        tool: `resource:${def.id}`,
        status: failed ? 'error' : 'ok',
        errorCode: failed
          ? outcome.error instanceof AbError
            ? outcome.error.code
            : ErrorCode.Internal
          : null,
        durationMs: Math.max(0, reader.ctx.clock.now() - started),
        requestsUsed: reader.ctx.budget.used,
        ...(failed ? { assetNumbers: [], queries: [] } : auditFacts(outcome.out)),
      });
    } catch {
      // An observer never changes a resource result.
    }
  };
  const read = async (
    def: ResourceDefinition,
    uri: URL,
    variables: Readonly<Record<string, string>>,
  ): Promise<ReadResourceResult> => {
    const reader = readerFor(def);
    const logger = reader.ctx.logger.child({ requestId: reader.ctx.requestId, resource: def.id });
    const started = reader.ctx.clock.now();
    try {
      const body = await def.read(reader, variables);
      logger.debug('resource ok', { ms: reader.ctx.clock.now() - started, requests: reader.ctx.budget.used });
      observe(def, reader, started, {
        out: { text: body.text, ...(body.meta === undefined ? {} : { meta: body.meta }) },
      });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: def.mimeType,
            text: body.text,
            ...(body.meta === undefined ? {} : { _meta: body.meta }),
          },
        ],
      };
    } catch (error) {
      observe(def, reader, started, { error });
      logger.warn('resource error', { ms: reader.ctx.clock.now() - started, error });
      throw toProtocolError(error);
    }
  };
  for (const def of reg.resources) {
    const config = { title: def.title, description: def.description, mimeType: def.mimeType };
    if (!isTemplate(def)) {
      server.registerResource(def.id, def.uri, config, (uri) => read(def, uri, {}));
      continue;
    }
    const template = new ResourceTemplate(def.uri, {
      list: async () => {
        if (def.list === undefined) return { resources: [] };
        const reader = readerFor(def);
        const started = reader.ctx.clock.now();
        try {
          const listed = await def.list(reader);
          observe(def, reader, started, {});
          return {
            resources: listed.map((r) => ({
              uri: r.uri,
              name: r.name,
              ...(r.title === undefined ? {} : { title: r.title }),
              mimeType: def.mimeType,
            })),
          };
        } catch (error) {
          // A listing that cannot be built (budget, upstream) is empty: it never fails the whole list.
          observe(def, reader, started, { error });
          return { resources: [] };
        }
      },
    });
    server.registerResource(def.id, template, config, (uri, variables) =>
      read(
        def,
        uri,
        Object.fromEntries(
          Object.entries(variables).map(([k, v]) => [k, Array.isArray(v) ? (v[0] ?? '') : v]),
        ),
      ),
    );
  }
}
