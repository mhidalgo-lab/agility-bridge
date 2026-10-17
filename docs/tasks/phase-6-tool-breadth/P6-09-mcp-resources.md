---
id: P6-09
title: MCP resources
phase: 6
status: todo
priority: medium
depends_on: [P2-17]
adr: ["0015"]
lessons: [L-153, L-038]
owner: ""
---

# P6-09 — MCP resources

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Reference material the agent can read on demand: filter vocabulary, instance schema, allowed projects, rubric.

## Scope
- Resources from the catalogue, served through the tool handlers (same limits, cache and audit), registered from one manifest.

## Acceptance criteria
- [ ] Every listed resource is readable (test); instance strings enveloped.

## Security notes
THREAT_MODEL A12.

## Lessons applied
- L-153 — Register prompts and resources from one manifest.
- L-038 — Everything that came from upstream is untrusted.

## Docs to update
- docs/reference/resources.md (new, generated)

## Out of scope
- Anything not listed under Scope.
