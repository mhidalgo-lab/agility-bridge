# Core contracts (`packages/core`)

The contracts every tool and every host (stdio CLI, Node HTTP, Workers) relies on. `packages/core` uses web-standard APIs
only ([ADR-0004](../adr/0004-typescript-runtime-agnostic-core.md)). Tool authors also follow the
[tool conventions](tool-conventions.md).

| Module | What it gives you |
|---|---|
| `tool.ts` | `ToolDefinition`, `defineTool`, `annotationsFor` |
| `registry.ts` | `ToolRegistry` (validation at startup, `select` per request) |
| `context.ts` | `ToolContext`, `Budget`, `Limits`, `DEFAULT_LIMITS`, clock, random, limiter |
| `errors.ts` | `AbError`, `ErrorCode`, `toToolErrorResult`, `toProtocolError` |
| `logger.ts` | `createLogger` (redacted JSON lines on stderr), `silentLogger` |
| `redact.ts`, `secret.ts` | `redact`, `redactValue`, `Secret` |
| `server.ts` | `buildMcpServer`, `withCachedJsonSchema` |

## Defining a tool

```ts
export const getAsset = defineTool({
  name: 'get_asset',
  title: 'Get asset',
  description: 'Get one work item by number (B-01234) or Story:1001, with its status, owners and sprint.',
  kind: 'read',            // read | write | destructive → MCP annotations (never written by hand)
  group: 'work',           // tool group, used by workspace tool policies
  cost: 2,                 // worst-case Agility requests per call, retries and resolution included (L-114)
  inputSchema: z.object({ asset: z.string().max(64) }),
  outputSchema: z.object({ number: z.string() }),   // open: extra properties allowed
  handler: async ({ asset }, ctx) => {
    ctx.budget.spend(1, 'the asset lookup');
    // ...
    return { text: '…', structured: { number: 'B-01234' } };
  },
});
```

The handler throws `AbError` for every expected failure. Anything else becomes `AB_INTERNAL: Internal error.
Reference: <request id>.` and its text is only logged (redacted), never returned.

## Registry

`ToolRegistry.register` refuses, at startup: a name that is not `snake_case` or longer than 64 characters, a duplicate,
a missing title, a description under 20 characters, an unknown `kind`, a group that is not `snake_case`, a `cost` that
is not an integer ≥ 0, an input property anywhere in the schema whose name looks like a secret (L-070, T23), and a
`write` or `destructive` tool unless the registry was created with `allowNonRead: true` (ADR-0013).

`select({ allowed, groups, kinds, maxCost })` picks the tools one caller may use: read tools only unless `kinds` says
otherwise, and never a tool whose declared cost exceeds the per-call budget (L-115). Only the selected tools are given
to `buildMcpServer`, so the others are neither listed nor callable.

## Per-request context

`ToolContext` carries everything a call may depend on: request id, Agility instance, credential (a `Secret`, never
printed), allowed Agility projects, asset-type allow and deny lists, limits, budget, limiter, metadata service,
logger, clock and random. It is frozen per call. **Nothing request-scoped lives in module state** (L-013, T21); the
only per-process cache in core is the JSON Schema cache, which holds static tool definitions.

`createBudget(n)` counts Agility requests: `used`, `remaining`, `canSpend(k)` and `spend(k, what)`, which throws
`AB_BUDGET_EXHAUSTED` with the numbers in `localDetails`.

## MCP server

`buildMcpServer({ tools, ctx, listChanged, errors, onToolCall })`:

- HTTP hosts build one server per request with that request's context (ADR-0005); stdio builds one per connection and
  passes a **factory**, called once per tool call, so every call gets a fresh request id and budget.
- `tools.listChanged` is `false` unless the host asks for it (L-016).
- Annotations come from `annotationsFor(kind)`.
- Input and output JSON Schemas are converted once per process and frozen; `$schema` is dropped and output schemas are
  opened (no `additionalProperties: false`). On 25 representative tools (`pnpm --filter @agility-bridge/core bench`,
  Node 24, 500 `tools/list` requests): **7.5 ms p50 / 12.8 ms p95 uncached, 1.9 ms / 2.5 ms cached** (L-020).
- `onToolCall` receives `{ tool, status, errorCode, durationMs, requestsUsed }` after each call, for audit (P2-08).

## Errors

`AbError(code, message, { hint, details, localDetails })` maps to a tool result with `isError: true`, the text
`CODE: message` plus `Hint:` and the `_meta['agility-bridge/error']` object `{ code, requestId }`. `details` are shown
only when `localDetails` is set (values the server built) or through the untrusted-data renderer (P1-05), because they
can contain Agility text. `toProtocolError` is for prompts and resources: client faults (`AB_INPUT_INVALID`,
`AB_NOT_FOUND`, …) become `-32602`, the rest `-32603`, with only the code in `data`.

## Logging and redaction

Log through `ctx.logger` (one JSON line per event on **stderr**; stdout is the stdio MCP channel). Every message and
field is redacted: secret-named keys at any depth are blanked, and free text loses bearer and basic credentials, any
`Authorization` scheme, `ab_` device and admin tokens, master keys, URL credentials, `access_token` parameters,
`x-api-key` values, `*_PASSWORD`/`*_SECRET`/`*_TOKEN` assignments, JWTs, well-known provider tokens and PEM blocks
(L-117). The corpus in `packages/core/test/redact.test.ts` also lists benign text that must survive; add a case for
every new secret shape.
