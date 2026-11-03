---
id: P8-44
title: Agility request count on stdio spans
phase: 8
status: todo
priority: low
depends_on: [P8-20]
adr: []
lessons: [L-118, L-119, L-469]
owner: ""
---

# P8-44 — Agility request count on stdio spans

> Filed by [P8-20](P8-20-stdio-telemetry.md) (D-329). Refine scope and acceptance criteria before starting.

## Goal
A stdio span carries `agility_bridge.requests` like an HTTP span, so someone who watches the local server sees how many Agility
requests a tool call used.

## Scope
- Give the tool-call event of `buildMcpServer` the request id of the call (the one in `ToolContext`), so a frame-level tracker can
  match the event to the JSON-RPC request when several calls run at once.
- The stdio tracker sets `requestsUsed` on the span of a `tools/call` from that event.

## Acceptance criteria
- [ ] Two concurrent calls of the same tool each get their own count (test).
- [ ] The HTTP spans are unchanged; the attribute list test still passes.

## Security notes
THREAT_MODEL T30: a count only; no new attribute.

## Lessons applied
- L-119 — the count is already on the allowlist.

## Docs to update
- docs/guide/observability.md (the stdio section)

## Out of scope
- Trace context from a stdio client.
