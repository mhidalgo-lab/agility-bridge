---
id: P1-17
title: Single-type paging counts upstream positions
phase: 1
status: review
priority: low
depends_on: [P1-16]
adr: ["0015"]
lessons: [L-064, L-170]
owner: "Matias Hidalgo"
---

# P1-17 — Single-type paging counts upstream positions

## Goal
A row the upstream should not have returned never shifts a cursor (Phase 1 review, low finding).

## Scope
- `runQuery` returns each kept row's upstream position; `query_assets`, `list_projects`, `list_teams`, `list_sprints`
  and `list_members` derive `hasMore` from the upstream count and `nextCursor` from the position after the last row
  shown, as `multiPage` does.

## Acceptance criteria
- [x] With a fake that returns out-of-scope rows inside a page, walking the pages shows every in-scope row exactly once.

## Security notes
THREAT_MODEL T3 (no data; correctness of paging only).

## Lessons applied
- L-064 — Recheck results, not only requests.
- L-170 — Merge pages by upstream position.

## Docs to update
- docs/dev/tool-conventions.md (Paging)

## Out of scope
- Multi-type pages (done in P1-16).
