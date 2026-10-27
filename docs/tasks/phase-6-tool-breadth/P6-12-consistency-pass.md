---
id: P6-12
title: Consistency pass (arguments, outputs, paging, tool count)
phase: 6
status: review
priority: medium
depends_on: [P6-07, P6-08, P6-09]
adr: ["0015"]
lessons: [L-030, L-032, L-155]
owner: "agent"
---

# P6-12 — Consistency pass (arguments, outputs, paging, tool count)

## Goal
The whole tool, resource and prompt surface reads like one API, within the client tool caps: an agent that learned
`asset`, `project`, `limit` and `nextCursor` on one tool calls the next one without reading its schema twice, and the
default `tools/list` has real headroom before the Phase 7 tools and more recipes land.

## Scope
1. **Review all 26 tools** (13 from Phases 1-2, 13 from Phase 6) against the
   [tool conventions](../../dev/tool-conventions.md): argument names, types and descriptions for the same concept
   (`asset`, `project`, `team`, `sprint`, `member`, `time_range`, `status`, `limit`, `cursor`, `format`,
   `include_closed`, `minimal_output`, `fields`, `contains`, `sort_by`), identity columns of rows, `partial` / `notes` /
   `truncated` / `nextCursor` semantics and declarations, error codes for the same mistake, title and description style,
   declared costs. Where a released argument or output field would have to be renamed, keep the old name as an alias
   (`packages/core/src/deprecations.ts`); a name that was never released is renamed with a changelog entry.
2. **Make drift impossible, with no exceptions list:** shared argument schemas in one place (`tools/common.ts`), and lints
   for the vocabulary (type and description of every shared name), titles, the paging sentence versus the `cursor`
   argument, the cost sentence, an imperative description opening, and the output keys the conventions name (types,
   camelCase, refused spellings, `partial` and `notes` on every list). A behavioural test runs every tool's worst case and
   checks identity columns first, declared shared keys, one error code per mistake and one paging contract.
3. **Size budget:** trim descriptions and schemas so the default `tools/list` is at most about 36 KB (it was 39.2 KB of
   40 KB) without lowering the router eval baseline (P6-10); raise the baseline when a description change improves it.
4. **Counts:** record the tool counts and `tools/list` sizes (default catalogue, every group) in the tool catalogue and the
   conventions, and the arithmetic that keeps every group plus the nine planned Phase 7 write tools below 40.
5. Refresh the Phase 6 rows of the tool catalogue so they match what was built.

## Acceptance criteria
- [x] Every shared argument name has one type and one description, from one schema; a lint refuses a tool that spells one
  differently, with no exceptions.
- [x] Titles, the paging sentence, the cost sentence, the description opening and the shared output keys are linted over the
  whole catalogue, each with refused examples.
- [x] A behavioural test over every tool's worst case covers identity columns, declared shared keys, error codes for the
  same mistake and one paging contract (cursor works, binds to its filters, keeps the first window).
- [x] Drift found in the review is fixed (listed in the changeset); any renamed released name has an alias in the
  deprecation registry, or the PR says there was none.
- [x] Default `tools/list` is at most about 36 KB and every-group at most 72 KB; both measured and recorded.
- [x] The router eval does not regress (baseline raised if it improved).
- [x] The tool count with every group and the nine Phase 7 tools is below 40, with the arithmetic recorded.
- [x] `docs/reference/tool-catalogue.md` Phase 6 rows match what was built; `docs/dev/tool-conventions.md` updated;
  generated references and the contract snapshot refreshed; a changeset.

## Security notes
None beyond the shared rules in AGENTS.md. No authorization, scope or budget behaviour changes; a cursor is now checked
before any other work in `list_members` (it was skipped when the project list was empty).

## Lessons applied
- L-030 — One name per concept, enforced by a lint.
- L-032 — One paging contract.
- L-155 — Keep the tool count small.

## Docs to update
- docs/reference/tool-catalogue.md
- docs/dev/tool-conventions.md
- docs/LESSONS-LEARNED.md
- docs/pending-decisions/phase-6.md

## Out of scope
- New tools, new arguments or new behaviour (a gap found here becomes a task).
- Rewriting the router eval; only its baseline moves.
