---
id: P6-37
title: Report schema-validation failures as AB_INPUT_INVALID tool errors
phase: 6
status: todo
priority: low
depends_on: [P6-12]
adr: ["0015"]
lessons: [L-019, L-030]
owner: ""
---

# P6-37 — Report schema-validation failures as AB_INPUT_INVALID tool errors

## Goal
The same mistake gets the same answer. Today a value the input schema refuses (`limit: 0`, an `asset_type` outside the
work-item enum, a missing required argument) is rejected by the MCP SDK before the handler runs and surfaces as a plain
"Input validation error" without a stable `AB_*` code or hint, while a value the handler refuses (a cursor, a time range,
an unknown asset type name) is `AB_INPUT_INVALID` with a hint (P6-12 consistency pass).

## Scope
- Decide, with the SDK's 2026-07-28 and 2025-era behaviour in hand, whether the framework can turn schema failures into
  an `isError` result with `AB_INPUT_INVALID`, the offending argument path and a `Hint:` line, for both revisions.
- If it can, do it once in the server wrapper (no per-tool code) and extend the consistency test with the schema cases.

## Acceptance criteria
- [ ] Decision recorded (ADR note or decision entry) with the SDK behaviour that was measured.
- [ ] If done: one test per mistake class (below minimum, wrong enum value, missing required, wrong type) over every tool.

## Security notes
None beyond the shared rules in AGENTS.md; the message must not echo a long or hostile value (truncate, envelope names).

## Lessons applied
- L-019 — Protocol errors versus tool errors.
- L-030 — One name and one answer per concept.

## Docs to update
- docs/dev/tool-conventions.md (Errors)

## Out of scope
- Changing which values a schema accepts.
