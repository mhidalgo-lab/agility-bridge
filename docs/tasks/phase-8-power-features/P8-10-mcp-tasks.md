---
id: P8-10
title: MCP Tasks for long-running reports
phase: 8
status: review
priority: low
depends_on: [P6-13]
adr: ["0005"]
lessons: [L-016, L-073]
owner: "agent (lane A)"
---

# P8-10 — MCP Tasks for long-running reports

## Goal
Long reports and large exports survive client timeouts.

## Scope
- **Advertised, not imposed:** `server/discover` lists `io.modelcontextprotocol/tasks` (`capabilities.extensions`) when `AB_TASKS` is not off. Only a 2026-07-28 `tools/call` that declares the extension in its client capabilities, for a granted **report tool** (read-only, group `reports`), becomes a task (D-253); every other request gets the inline result.
- **Methods:** `tasks/get`, `tasks/update` (always refused: nothing asks for input, D-255) and `tasks/cancel`, answered in the HTTP layer before the SDK (which has no Tasks runtime), for 2026-07-28 requests only; a 2025-era `tasks/*` is method-not-found. Statuses `working`, `completed`, `failed`, `cancelled` with the extension's `CreateTaskResult` / `DetailedTask` shapes (`taskId`, `status`, `createdAt`, `lastUpdatedAt`, `ttlMs`, `pollIntervalMs`, `result`, `error`).
- **Authorisation:** every request is authenticated as any MCP request, then must match the record's grant, workspace and device token (D-254); everything else is one identical "Unknown or expired task". No tasks for pass-through callers.
- **Records:** SHA-256 of a 256-bit id as the key, the record sealed with the `task` key purpose, 15-minute TTL in `kv`.
- **Execution:** no background work. The first `tasks/get` takes an atomic lease and runs the stored call through the normal MCP pipeline in that request (its budget, quota, rate limits, audit); a concurrent poll sees `working`; a cancel during the run wins (D-252).
- **`AB_TASKS=off`** (default on, D-256): not advertised, `tasks/*` is method-not-found, declared calls run inline.

## Acceptance criteria
- [x] Lifecycle (create, first poll runs once, later polls read the stored result, expiry), cancellation (before and during a run), `tasks/update` refusal, isolation (another device, grant, workspace, person, no token, guessed and malformed handles, 2025-era requests), declaration rules (undeclared, 2025-era, non-report tool, ungranted tool) and kill-switch tests.
- [x] Records are sealed and stored under hashed keys (a test reads the raw `kv` rows); no background work.
- [x] `docs/guide/tasks.md`, THREAT_MODEL T32, settings reference.
- [ ] Verified with MCP Inspector and a real 2026-07-28 client: *unverified*, left for the Phase 8 review's live pass (P8-15). `input_required` is never produced by any task tool, so its tests are the `tasks/update` refusal.

## Security notes
THREAT_MODEL T32.

## Lessons applied
- L-016 — Advertise only what works on that transport.
- L-073 — One-time state is consumed atomically.

## Docs to update
- docs/guide/tasks.md (new)

## Out of scope
- Anything not listed under Scope.
