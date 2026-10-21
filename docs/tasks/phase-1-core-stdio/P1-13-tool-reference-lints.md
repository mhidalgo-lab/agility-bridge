---
id: P1-13
title: Generated tool reference, naming and description lints, tools/list budget
phase: 1
status: done
priority: medium
depends_on: [P0-11, P1-08]
adr: ["0015"]
lessons: [L-022, L-030, L-031, L-134, L-150, L-155]
owner: "Matias Hidalgo"
---

# P1-13 — Generated tool reference, naming and description lints, tools/list budget

## Goal
Keep the tool surface consistent and documented automatically.

## Scope
- Generator for `docs/reference/tools.md` from the registry.
- Naming lint, description lint, secret-field check, `tools/list` size and count budget (default catalogue and every optional group).
- Defaults in descriptions generated from the schema.
- Test that tool definitions contain no instance-derived strings (THREAT_MODEL A12).

## Acceptance criteria
- [x] CI fails on any violation; the reference is regenerated and committed.
- [x] Budget numbers (count and characters) recorded in the PR.

## Security notes
THREAT_MODEL A12.

## Lessons applied
- L-022 — Budget the `tools/list` payload.
- L-030 — One name per concept, enforced by a lint.
- L-031 — Descriptions are prompts.
- L-134 — Generate references from code.
- L-150 — Instructions, descriptions and defaults must agree.
- L-155 — Keep the tool count small.

## Docs to update
- docs/reference/tools.md (generated)
- docs/reference/tool-catalogue.md

## Out of scope
- Anything not listed under Scope.
