---
id: P1-07
title: Tools: whoami, list_projects, list_asset_types, describe_asset_type
phase: 1
status: todo
priority: high
depends_on: [P1-03, P1-05, P1-12]
adr: ["0015"]
lessons: [L-025, L-042, L-043, L-147, L-155]
owner: ""
---

# P1-07 — Tools: whoami, list_projects, list_asset_types, describe_asset_type

## Goal
Let an agent learn where it is and what it can reach before it queries anything.

## Scope
- `whoami`: member behind the token, instance (and version when available), workspace, allowed Agility projects, asset types, enabled groups, limits and budgets by unit, write availability and approval channel.
- `list_projects` (paged, within the workspace), `list_asset_types` (prefix, allowed), `describe_asset_type` (attributes, operations, statuses, tiers).
- Shapes as in docs/reference/tool-catalogue.md.

## Acceptance criteria
- [ ] Contract tests (schemas, description and naming lints).
- [ ] Negative authorization: disallowed asset types are hidden and refused.
- [ ] Names and metadata strings enveloped; declared costs verified by the cost test.

## Security notes
THREAT_MODEL T3, A12.

## Lessons applied
- L-025 — Not every client can answer an approval prompt.
- L-042 — Name every limit by its unit.
- L-043 — Keep identity on every row.
- L-147 — Access tokens are full delegation and never expire.
- L-155 — Keep the tool count small.

## Docs to update
- docs/reference/tool-catalogue.md

## Out of scope
- Anything not listed under Scope.
