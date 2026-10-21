---
id: P1-01
title: Core skeleton, tool registry and error model
phase: 1
status: done
priority: high
depends_on: [P0-13]
adr: ["0004", "0005", "0015"]
lessons: [L-013, L-016, L-019, L-020, L-042, L-070, L-114, L-117, L-154, L-165]
owner: "Matias Hidalgo"
---

# P1-01 — Core skeleton, tool registry and error model

## Goal
The contracts every tool relies on: tool definitions, the registry, the per-request context, the error model, the redacting logger, the budget and the MCP server builder.

## Scope
- `ToolDefinition { name, title, description, kind, group, cost, inputSchema (zod 4 → JSON Schema 2020-12), outputSchema (open), handler }`.
- Registry validation: unique `snake_case` names, description present, secret-like fields refused, integer `cost ≥ 0`, non-read tools only with `allowNonRead`; annotations derived from `kind`.
- `ToolContext`: request id, instance, credential, Agility projects, asset types, limits, budget, limiter, metadata service, logger, clock, random — immutable, per request.
- `AbError(code, message, { hint, details })` → tool result mapping; unexpected errors → `AB_INTERNAL` with a reference id; `ProtocolError` mapping for prompts and resources.
- Redacting structured logger (stderr only).
- Budget object reporting requested / used / remaining Agility requests.
- `buildMcpServer(context, tools)`: registers only allowed tools, prompts and resources; `listChanged: false`; cached schema conversion.

## Acceptance criteria
- [x] Unit tests for every registry refusal (bad name, secret-like field, missing cost, write without `allowNonRead`).
- [x] Annotation derivation tested for `read`, `write`, `destructive`.
- [x] Error mapping tests include the request id and never the original exception text.
- [x] Redaction corpus: `Bearer`, `Basic`, custom schemes, `ab_` tokens, URL credentials, `access_token` parameters, `x-api-key` JSON, `DB_PASSWORD`-style names, PEM blocks — plus benign words that must survive.
- [x] A concurrency test runs two contexts with different credentials in parallel and proves no bleed.
- [x] Schema-conversion cache measured (before/after numbers in the PR).

## Security notes
THREAT_MODEL T8, T21, T23.

## Lessons applied
- L-013 — Never keep request data in module state.
- L-016 — Advertise only what works on that transport.
- L-019 — Use protocol errors deliberately.
- L-020 — Cache converted tool schemas.
- L-042 — Name every limit by its unit.
- L-070 — Secrets are never tool arguments.
- L-114 — Declared costs cover the worst case.
- L-117 — Redaction is broad and tested.
- L-154 — Annotations are hints that most clients ignore.
- L-165 — Each redaction case asserts its own secret.

## Docs to update
- docs/dev/core.md (new)
- docs/dev/tool-conventions.md

## Out of scope
- Agility HTTP calls (P1-02)
