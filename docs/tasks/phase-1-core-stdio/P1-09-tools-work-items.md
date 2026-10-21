---
id: P1-09
title: "Tools: search_work_items, get_work_item, list_my_work"
phase: 1
status: done
priority: high
depends_on: [P1-08]
adr: ["0015"]
lessons: [L-033, L-042, L-043, L-142, L-150]
owner: "Matias Hidalgo"
---

# P1-09 — Tools: search_work_items, get_work_item, list_my_work

## Goal
Friendly, cheap tools for the daily questions: find work, open one item with its context, and see my work.

## Scope
- `search_work_items` (backlog items, defects, tasks, tests) with project, team, sprint, member, status, status category, text filters.
- `get_work_item`: description and acceptance criteria as text (the acceptance-criteria attribute is instance-specific: discovered from metadata or configured), owners, status, sprint, parent epic, child tasks and tests, links, comment count.
- `list_my_work` for `me` or another member, grouped by sprint and status.

## Acceptance criteria
- [x] Fixture tests with `B-`/`S-`, `D-`, `TK-` and `AT-` items; children and parent shown; status names come from the instance.
- [x] `partial` with notes when children or links are capped.

## Security notes
THREAT_MODEL A1, A7.

## Lessons applied
- L-033 — Never turn missing data into zeros or confident claims.
- L-042 — Name every limit by its unit.
- L-043 — Keep identity on every row.
- L-142 — Status, AssetState and rollup category are different things.
- L-150 — Instructions, descriptions and defaults must agree.

## Docs to update
- docs/reference/tool-catalogue.md

## Out of scope
- Anything not listed under Scope.
