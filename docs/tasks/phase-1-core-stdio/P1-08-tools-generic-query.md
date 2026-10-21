---
id: P1-08
title: "Tools: query_assets and get_assets"
phase: 1
status: review
priority: high
depends_on: [P1-04, P1-05, P1-06, P1-12]
adr: ["0012", "0015"]
lessons: [L-032, L-034, L-043, L-050, L-064, L-145]
owner: "Matias Hidalgo"
---

# P1-08 — Tools: query_assets and get_assets

## Goal
Read any asset type the instance exposes — including defects, tasks, tests, issues, requests and regression assets, with their custom fields — through two safe, generic tools.

## Scope
- `query_assets` and `get_assets` per the catalogue; field tiers, `minimal_output`, `format`, cursor paging.
- Scope recheck of every row (`hiddenOutsideScope`); `notFound` list for `get_assets`.
- Paging per the final conventions: `nextCursor` only when `limit + 1` rows came back, no `total` (P0-06); default sort by `ID`; a change-date sort declares its cost.
- Workspace switch `AB_GENERIC_QUERY` removes both tools. *(Both tools are the `query` group; a workspace without it
  selects neither. Reading `AB_GENERIC_QUERY` into the stdio workspace is P1-11.)*

## Acceptance criteria
- [x] Fixture tests across Story, Defect, Task, Test, Epic, Issue, Request and RegressionTest, including `Custom_` fields (starting from `packages/core/test/fixtures/agility/`).
- [x] Global types are refused unless the workspace allows them; denied and unclassified types are refused.
- [x] A cursor from another tool, workspace or filter set is refused before any request.
- [x] With the switch off, neither tool is listed nor callable.

## Security notes
THREAT_MODEL T3, T4, T22, A3, A4.

## Lessons applied
- L-032 — One paging contract.
- L-034 — Filter before you cap.
- L-043 — Keep identity on every row.
- L-050 — Ask only for the fields a tool needs.
- L-064 — Recheck results, not only requests.
- L-145 — Single-asset URLs ignore `where`.

## Docs to update
- docs/reference/tool-catalogue.md

## Out of scope
- Anything not listed under Scope.
