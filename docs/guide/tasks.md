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
   `tasks/update` answers an error: no report asks for input, so a task is never `input_required`.

Nothing runs after a response is sent (no `waitUntil`, no timer): the work happens only inside a request the client made.
That also means the report still has to fit one request (the 180 s deadline and the call budget); what a task buys is that
the client's *tool call* returns at once and the client can poll later, even after reconnecting.

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

A task is two `kv` rows (the record and, while a poll runs it, a lease) in the storage `kv` table and about 4 statements
per poll; on the Workers Free D1 budget that is a few rows per task, far below a write.
