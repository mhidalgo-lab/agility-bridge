---
id: P0-11
title: Tool contract and conventions
phase: 0
status: done
priority: high
depends_on: [P0-06, P0-07, P0-14]
adr: ["0012", "0015"]
lessons: [L-005, L-030, L-031, L-032, L-033, L-038, L-042, L-045, L-150, L-153, L-155]
owner: "Matias Hidalgo"
---

# P0-11 — Tool contract and conventions

## Goal
Freeze the tool contract — names, arguments, outputs, errors, paging, envelope, kinds, costs, deprecations — and the default catalogue before the first tool is built.

## Decisions
- D-05 (2026-10-19): every read group on by default except `reports` (20 read tools); `writes` off.
- D-06 (2026-10-19): member emails off by default, enabled per workspace (`AB_MEMBER_EMAILS` in stdio).
- D-07 (2026-10-19): generic query on; starting limits 30 fields, nesting depth 2, 5 aggregations, 3 `any_of` groups,
  100 rows per call (hard 1,000), revisited with P0-06 measurements.
- D-08 (2026-10-19): an opt-in attachment-download tool in its own `attachments` group, off by default (35 tools with
  every group and all writes).
- D-19 (2026-10-19): `sprint` in arguments; descriptions say "backlog item (story)" and "sprint (iteration)"; schemas use
  the API names.

## Scope
- Finalise docs/dev/tool-conventions.md with what the spikes taught (status vocabulary, number formats, paging semantics, estimate units).
- Accept ADR-0015.
- Default tool groups and budgets: default catalogue ≤ 25 tools, everything < 40, a serialized `tools/list` size budget.
- The final `AB_*` error-code list.
- Specifications (with examples) for the naming, description, secret-field and size lints built in P1-13.
- Decide the follow-ups proposed by the prior-art review (P0-10, [docs/research/prior-art.md](../../research/prior-art.md)
  §Proposed follow-ups): deferred-tool fallback, aliases on rename, read-only connection variant, operator caps,
  lint additions and negative query fixtures.
- Decide how nullable fields appear in input and output schemas: MCP Inspector's `--strict` flags `type: ["string",
  "null"]` (zod `.nullable()`) as unportable to single-`type` dialects (P0-07 finding 8); prefer omitting the field, and
  have the P1-13 schema lint enforce the choice.

## Acceptance criteria
- [x] Conventions marked final; ADR-0015 accepted. *(2026-10-21)*
- [x] Lint specifications include examples of refused names and descriptions.
- [x] The tool catalogue shows groups and counts.
- [x] Owner sign-off recorded in the pending decisions. *(docs/pending-decisions/phase-0.md, Sign-offs)*

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
