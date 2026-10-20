# P0-07 results: MCP SDK v2 dual-era handler with real clients

Date: 2026-10-20. Status: **runtimes, elicitation channels and schema caching verified locally; most of the real-client
matrix needs the owner** ([`client-checklist.md`](client-checklist.md)). Nothing here used Agility or a real token: the
tools return canned, synthetic data.

## Versions (all at least 3 days old)

| Package | Version |
|---|---|
| `@modelcontextprotocol/server`, `@modelcontextprotocol/client` | 2.3.1 |
| `hono` / `@hono/node-server` | 4.13.13 / 2.1.4 |
| `zod` | 4.6.7 |
| `wrangler` (local `workerd`) | 4.149.0 |
| `@modelcontextprotocol/inspector` (CLI) | 2.11.0 |
| Node / TypeScript | 24.16.0 / 7.0.2 (root `tsc` typechecks the spike cleanly) |

## What the spike is

`src/server.ts` builds one server per request from a fake workspace grant: `whoami`, `query_assets` (JSON Schema
2020-12 input with `$defs`/`oneOf` through `fromJsonSchema`, zod `outputSchema`, `structuredContent`), `get_work_item`
(an `AB_NOT_FOUND` tool error) and `add_comment`, a write that asks for approval. Workspace `team` gets all four tools,
`viewer` only the reads. `src/app.ts` serves `/w/:slug/mcp` with a static bearer per workspace
(`ab_spike_<slug>`, not a secret) on Node (`@hono/node-server`) and on local workerd (`wrangler dev`); `src/stdio.ts`
serves stdio.

## Automated matrix (`test/run.ts`)

{Node, local workerd, stdio} × {2025-era client, 2026-07-28 client} × {workspace `team`, `viewer`} × {client with and
without the elicitation capability}. Every case checks the negotiated era, the exact tool list per workspace,
`readOnlyHint` on reads, `$defs`/`oneOf` kept in the input schema, `outputSchema`, `structuredContent`, schema-level
rejection of an unknown operator, a tool error as `isError`, and that the hidden write tool is refused on `viewer`.
HTTP adds raw checks: unknown workspace, missing bearer and another workspace's bearer → 401; standalone SSE `GET` →
405.

| Runtime | 2025-era | 2026-07-28 | Notes |
|---|---|---|---|
| Node (`@hono/node-server`) | ✅ | ✅ | |
| Workers (local workerd) | ✅ | ✅ | no `nodejs_compat` needed |
| stdio (`serveStdio`) | ✅ | ✅ | era pinned per connection |
| Raw requests (Node and workerd) | 401 / 401 / 401 / 405 as expected | | |
| **JSON-RPC batch** | ❌ **accepted and answered** | 400 (unrelated: era detection) | see finding 2 |

## Write approval: which channel works where

`add_comment` asks for approval with `ctx.mcpReq.elicitInput` (2025 era, a server-to-client `elicitation/create`) or
returns `inputRequired(...)` (2026-07-28, multi round trip: the client answers the embedded elicitation and retries).

| Transport | Era | Client declares elicitation | Result |
|---|---|---|---|
| stdio | 2025 | yes | ✅ approved via `elicitation/create` |
| stdio | 2025 | no | refused cleanly: `AB_APPROVAL_UNAVAILABLE` |
| stdio | 2026-07-28 | yes | ✅ approved via `input_required` |
| stdio | 2026-07-28 | no | refused: the SDK throws before sending (capability not declared) |
| HTTP (Node and workerd) | 2025 | **yes** | **refused**: each stateless request builds a new server that never saw the client's capabilities |
| HTTP (Node and workerd) | 2025 | no | refused cleanly |
| HTTP (Node and workerd) | 2026-07-28 | yes | ✅ approved via `input_required` |
| HTTP (Node and workerd) | 2026-07-28 | no | refused: the SDK throws before sending |

**Conclusion for P7-01 and P7-02:** elicitation approves a write on **stdio** (either era) and on **2026-07-28 HTTP**,
and only when the client declares the capability. On **2025-era HTTP it never works**, whatever the client supports,
because HTTP is stateless (ADR-0005). Applied to the documented eras ([client compatibility](../../docs/reference/client-compatibility.md)):

| Client | stdio | Remote HTTP |
|---|---|---|
| VS Code (Copilot), Cursor (≤ 2025-11-25) | elicitation, if declared | **approval page only** |
| JetBrains (Copilot) | elicitation, if declared | approval page unless it negotiates 2026-07-28 (era unknown) |
| Claude Code, Copilot CLI (2026-07-28) | elicitation | elicitation (`input_required`); **verified for Copilot CLI 1.0.87 on stdio and HTTP** |
| Windsurf / Devin Desktop (2026-07-28, elicitation not claimed) | approval page or refusal | approval page |
| MCP Inspector CLI 2.11.0 | none (the CLI does not elicit) | none |

Per-client confirmation (does the client really declare and render elicitation?) is part of the owner's checklist.

## Schema caching (`test/bench.ts`, L-020)

`tools/list` through `createMcpHandler`, a new server per request (as on HTTP), 500 requests per row after 50 warm-up
requests, one event-loop turn per request. Node 24.16.0 on an Intel i7-10750H (WSL2). Tool schemas resemble a paged
list tool with a discriminated-union filter.

| Tools | Variant | p50 ms | p95 ms | `tools/list` bytes |
|---|---|---|---|---|
| 25 | zod schemas built per request | 9.99 | 21.83 | 39,548 |
| 25 | zod schemas shared, converted per request | 4.89 | 6.68 | 39,548 |
| 25 | **JSON Schema converted once (`fromJsonSchema`)** | **0.70** | **0.96** | 41,923 |
| 40 | zod schemas built per request | 13.87 | 24.65 | 63,248 |
| 40 | zod schemas shared, converted per request | 7.60 | 9.57 | 63,248 |
| 40 | **JSON Schema converted once (`fromJsonSchema`)** | **0.91** | **1.32** | 67,048 |

Converting each tool's schemas to JSON Schema **once per process** and registering them with `fromJsonSchema` makes
building the per-request server about **7–8× cheaper** than letting the SDK convert zod schemas on every request. P1-01
should build the tool registry this way. The serialised list is about 1.6 KB per tool here; P0-11 sets the real
`tools/list` size budget from the actual schemas.

## Findings

1. **2025-era HTTP cannot elicit** (above). It confirms L-025 and L-156 with evidence: the out-of-band approval page
   (P7-02) is required for VS Code, Cursor and JetBrains over HTTP.
2. **The SDK accepts JSON-RPC batches on the 2025-era path** (2.3.1): a two-request array with
   `mcp-protocol-version: 2025-11-25` was answered with two results, although batching was removed from the protocol in
   2025-06-18. ADR-0005 already says batches are rejected *before* the SDK; P2-06 must do it in the Hono app (refuse a
   JSON array body with a JSON-RPC error and HTTP 400) and test it (L-014).
3. **A tight `await` loop leaks every request in a benchmark, not in a server.** The first benchmark ran out of memory:
   after 1,000 requests, 1,000 `McpServer`, `Server` and `WebStandardStreamableHTTPServerTransport` objects were still
   alive. The heap snapshot's retainer path ended at V8's `weak_refs_keep_during_job` list (each request's
   `AbortSignal` → the transport's teardown listener → the server). That list is cleared only when the current job
   finishes, and a loop of `await`s never finishes it. With one `setImmediate` turn per request the heap stays flat
   (24.3 MB after 1,000 pings, 24.1 MB after 4,000). Benchmarks and load tests must yield to the event loop between
   requests (`test/heap.ts` reproduces both cases; lesson L-159).
4. **No `nodejs_compat` flag** is needed for the MCP layer on Workers, and the 2020-12 schemas (`$defs`, `oneOf`,
   `const`) validate server-side on workerd and Node alike.
5. **MCP Inspector CLI 2.11.0** negotiates the 2025 era on HTTP and stdio, renders `structuredContent`, cannot answer
   elicitation (so writes are refused with `AB_APPROVAL_UNAVAILABLE`), and its `-e KEY=value` flag now reaches a stdio
   server's environment (it did not in relic-bridge's run with 2.8.0).
6. **Bearer handling is the app's job**: the SDK never reads headers. The Hono route resolves the workspace and token
   first and hands the grant to the factory through `authInfo.extra` (no module state, L-013).

## Real clients

| Client | Version | Transport | Listed | Call | Era | Elicitation | Source |
|---|---|---|---|---|---|---|---|
| MCP Inspector CLI | 2.11.0 | HTTP (Node, workerd), stdio | ✅ | ✅ | 2025 | ❌ (CLI) | this spike, 2026-10-20 |
| Claude Code | 2.1.287 | HTTP, HTTP + `Authorization` header, stdio | ✅ | ✅ | 2026-07-28 | not tested | relic-bridge P0-07, 2026-10-02 |
| GitHub Copilot (desktop) | 2026-10 | HTTP | ✅ | ✅ | — | not tested | relic-bridge P0-07, 2026-10-02 |
| **GitHub Copilot CLI** | **1.0.87** | HTTP (Node) and stdio, `team` and `viewer` | ✅ | ✅ | **2026-07-28** on both | ✅ **prompt shown and approved on both** (`input_required`) | owner, 2026-10-20 |
| VS Code, JetBrains, Claude Code (re-run), Claude Desktop, Cursor, Windsurf / Devin Desktop | — | — | — | — | — | — | **owner checklist** |

**GitHub Copilot CLI 1.0.87** (owner run, 2026-10-20, Linux, all four spike servers added with `copilot mcp add`, the
test prompt from the checklist):

- Tool lists match the grants: `team` shows `whoami`, `query_assets`, `get_work_item`, `add_comment`; `viewer` shows no
  `add_comment`, and the model could not call it there.
- `whoami` answered `era=modern` over **HTTP and stdio**: Copilot CLI negotiates 2026-07-28 on both.
- `query_assets` returned `structuredContent` (`rows`, `total: 2`, `nextCursor`); the unknown operator was refused by
  server-side schema validation with the full JSON Schema error list (`must be equal to one of the allowed values`, …,
  `must match exactly one schema in oneOf`); `get_work_item B-99999` came back as a tool error (`AB_NOT_FOUND`).
- `add_comment` on both `team` servers **showed an approval prompt**; approving it returned `approved via
  input_required`. The owner approved every prompt, so the **decline path was not exercised** (both second calls were
  approved too); it is still to check.
- Read-only calls ran without a confirmation prompt in this session (the session's tool-permission settings were not
  recorded). The model did not see `readOnlyHint` annotations.
- No connection failures or timeouts.

The relic-bridge rows come from a sibling project by the same maintainer that uses the same SDK and server pattern; a
client's protocol behaviour does not depend on the server's domain, so they are carried over with their source and
date, not as agility-bridge verification. relic-bridge also observed that Claude Code sends `server/discover`,
`Mcp-Method` / `Mcp-Name` headers and a long-lived `subscriptions/listen` POST (P2-06 must handle it deliberately), and
that a 2025-era client's standalone SSE `GET` gets 405 and carries on.

## Reproduce

```sh
cd spikes/mcp-sdk-v2 && pnpm install
PORT=8787 pnpm node &                         # Node
pnpm exec wrangler dev --port 8788 &          # local workerd, no Cloudflare account needed
pnpm test http http://127.0.0.1:8787
pnpm test http http://127.0.0.1:8788
pnpm test stdio
pnpm bench
node --expose-gc --import tsx test/heap.ts ping 4000            # grows
YIELD=1 node --expose-gc --import tsx test/heap.ts ping 4000    # flat
npx @modelcontextprotocol/inspector@2.11.0 --cli http://127.0.0.1:8787/w/team/mcp --transport http \
  --header "Authorization: Bearer ab_spike_team" --method tools/list
```
