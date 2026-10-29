---
id: P6-34
title: Tune tool descriptions from the eval misses
phase: 6
status: done
priority: low
depends_on: [P6-33]
adr: ["0015"]
lessons: [L-124, L-309, L-310]
owner: ""
---

# P6-34 — Tune tool descriptions from the eval misses

## Goal
Raise tool-choice accuracy where the LLM eval and the lexical router agree a description misleads, without growing `tools/list`.

## Scope
- Start from the misses in the P6-10 triage table (get_conversations, get_asset_history, list_my_work, "open defects" questions) and the P6-33 report.
- P6-33 (2026-10-28) named three: Q023 (`list_my_work` does not say it takes another member: "Marcus's plate"), Q030
  (`list_sprints` should say it covers future sprints: "which sprint starts next"), Q049 (`list_attachments` should name
  links). See the table in docs/dev/evals.md.
- Change wording only, inside the description lints and the default `tools/list` budget (40 KB); trade words, not features.
- Raise the router baseline with the change (`pnpm eval:router --write-baseline`).

## Progress (2026-10-29)
- Q023 and Q030 were legitimate routes, not description bugs: the dataset accepts `search_work_items` (member and sprint) and
  `get_sprint` (`sprint: next`) (L-312).
- Q049: a "attachments: list_attachments" pointer in `get_work_item` made the lexical router pick `get_work_item` for more
  attachment questions, so it was not kept; `list_attachments` already names links. Watched in the next LLM run.
- `query_assets` now names goals, themes and retrospectives among its types, so generic questions about them route to it.
- New dataset questions: Q074 (`quality_scan`), Q075 (themes), Q076 (retrospectives). Router 76 questions: top-1 78.9 %,
  top-3 90.8 % (floor 78 % / 90 %, unchanged after rounding). Default `tools/list` within the 37.6 KB target.
- **Owner step left:** rerun the LLM eval on the changed descriptions and attach the report.

## Acceptance criteria
- [x] Router top-1 and top-3 do not fall and the baseline is raised where they improved (78.9 % / 90.8 %; floors unchanged after rounding).
- [x] The LLM eval is rerun on the changed descriptions and its report attached ([Sonnet](../../dev/eval-reports/2026-10-29-sonnet-5-5.md), [Opus](../../dev/eval-reports/2026-10-29-opus-5-5.md)).
- [x] Lints and the `tools/list` size test stay green; tool reference regenerated.

## Security notes
Descriptions never carry instructions about other content (conventions).

## Lessons applied
- L-031, L-124, L-309.

## Docs to update
- docs/dev/evals.md, docs/reference/tools.md (generated)

## Out of scope
- Renaming tools or arguments (a breaking change).
