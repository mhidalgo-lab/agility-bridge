---
id: P0-11
title: Tool contract and conventions
phase: 0
status: todo
priority: high
depends_on: [P0-06, P0-07, P0-14]
adr: ["0012", "0015"]
lessons: [L-005, L-030, L-031, L-032, L-033, L-038, L-042, L-045, L-150, L-153, L-155]
owner: ""
---

# P0-11 — Tool contract and conventions

## Goal
Freeze the tool contract — names, arguments, outputs, errors, paging, envelope, kinds, costs, deprecations — and the default catalogue before the first tool is built.

## Scope
- Finalise docs/dev/tool-conventions.md with what the spikes taught (status vocabulary, number formats, paging semantics, estimate units).
- Accept ADR-0015.
- Default tool groups and budgets: default catalogue ≤ 25 tools, everything < 40, a serialized `tools/list` size budget.
- The final `AB_*` error-code list.
- Specifications (with examples) for the naming, description, secret-field and size lints built in P1-13.

## Acceptance criteria
- [ ] Conventions marked final; ADR-0015 accepted.
- [ ] Lint specifications include examples of refused names and descriptions.
- [ ] The tool catalogue shows groups and counts.
- [ ] Owner sign-off recorded in the pending decisions.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-005 — Fix the tool contract before building many tools.
- L-030 — One name per concept, enforced by a lint.
- L-031 — Descriptions are prompts.
- L-032 — One paging contract.
- L-033 — Never turn missing data into zeros or confident claims.
- L-038 — Everything that came from upstream is untrusted.
- L-042 — Name every limit by its unit.
- L-045 — Deprecate on purpose.
- L-150 — Instructions, descriptions and defaults must agree.
- L-153 — Register prompts and resources from one manifest.
- L-155 — Keep the tool count small.

## Docs to update
- docs/dev/tool-conventions.md
- docs/adr/0015-tool-output-contract.md
- docs/reference/tool-catalogue.md
- docs/ARCHITECTURE.md §7

## Out of scope
- Implementing the lints (P1-13)
