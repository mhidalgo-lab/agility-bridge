# MCP Tasks

> Long reports that survive a client's timeout (P8-10). The extension is `io.modelcontextprotocol/tasks` (SEP-2663, MCP
> 2026-07-28). On by default; `AB_TASKS=off` removes it. Design: [ADR-0005](../adr/0005-mcp-sdk-v2-stateless.md), threat:
> [THREAT_MODEL](../THREAT_MODEL.md) T32, decisions D-252 to D-256 in [pending decisions](../pending-decisions/phase-8.md).
>
> **Unverified:** built against the extension's published schema and tested with raw JSON-RPC on fakes. It has not been
> run with MCP Inspector or a real client yet ([P8-15](../tasks/phase-8-power-features/P8-15-tasks-live-check.md)).

## How it works

1. The server lists the extension in `server/discover` (`capabilities.extensions`). Listing it is not using it.
2. A **2026-07-28** request that declares `io.modelcontextprotocol/tasks` in its `_meta` client capabilities and calls a
   **report tool** (the `reports` group, which an owner enables per workspace) gets a task back immediately:
   `{ "resultType": "task", "taskId", "status": "working", "ttlMs": 900000, "pollIntervalMs": 2000, ... }`. Any other
   request (2025-era, undeclared, another tool) gets the ordinary inline result, so a client that does not know tasks
   never sees one.
3. `tasks/get` with the `taskId`. **The first poll runs the report**, inside that request and its Agility request budget,
   quota, rate limits and audit like any other call, and answers `completed` with the tool's normal result (an error
   result of the tool is a `completed` task whose result says so; `failed` is for a JSON-RPC error). A poll that arrives
   while another is running it answers `working`. Later polls return the stored result until it expires.
4. `tasks/cancel` ends a `working` task as `cancelled`; a report already running finishes, but its result is dropped.
   `tasks/update` answers an error: no report asks for input, so a task is never `input_required`. A cancel that arrives
   at the moment the report finishes still wins: the finishing poll checks for it after saving (review Q-5).
5. `ttlMs` is the time the task has left, not the original 15 minutes.

## What a task may carry

Creating a task checks the call first, so a bad one never becomes a stored task that fails later: the arguments must be an
object, at most 8 KiB, and valid for the tool's input schema. One grant may start **30 tasks per 15 minutes**. A result is
kept only if it fits one `kv` value (about 150,000 characters); a larger one ends the task as `failed` with a short message.
A finished result is returned only while the caller still has that report tool **and** the same project scope, asset-type
lists and limits as when the report ran; after the grant is narrowed the handle answers "Unknown or expired task".

Nothing runs after a response is sent (no `waitUntil`, no timer): the work happens only inside a request the client made.
That also means the report still has to fit one request: the poll that runs it has the same 180 s deadline as any request,
and a report that does not finish in time **fails the task** (`failed`, "took too long") instead of leaving it half-run.
What a task buys is that the client's *tool call* returns at once and the client can poll later, even after reconnecting.

**A poll the client abandons.** If the client drops the connection of the poll that is running the report, the platform may
cancel that request without telling us; the task then stays `working` until its lease ends (about 200 seconds), later polls
answer `working`, and the first poll after that runs the report again (one more budget, quota and audit row). Reports only
read, so a repeat is safe, but it is not free; running the report outside the poll needs a Durable Object or queue
([P8-36](../tasks/phase-8-power-features/P8-36-background-task-runner.md)). A runner that throws, or a result too large to keep, ends the task as
`failed` and frees the lease at once.

## Who can see a task

The handle is 256 random bits shown once; the store keeps only its SHA-256 and a record sealed with a key derived from the
master key (the `task` purpose), so a copy of the database holds no usable handle and no report. Every `tasks/*` request
is authenticated like any MCP request and then must come from the **same device token, grant and workspace** that created
the task; anyone else, a guessed handle, a malformed one and an expired one all get the same "Unknown or expired task".
Pass-through callers (who share one identity) get no tasks. A task lives 15 minutes.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `AB_TASKS` | `on` | `off` stops advertising the extension and answers `tasks/*` with method-not-found; declared calls run inline |

## What it costs

A task is a few `kv` rows (the record, the creation counter of the grant, and while a poll runs it a lease) in the storage `kv`
table: creating one is 2 statements, the poll that runs the report about 6, a poll of a finished task 1 (derived from the code,
[Cloudflare limits](cloudflare-limits.md#tasks-and-telemetry)); on the Workers Free D1 budget that is about a dozen rows with
the audit and quota rows of the report itself, far below a write.
