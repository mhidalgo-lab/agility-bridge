---
id: P6-22
title: Portfolio items in list_recent_changes
phase: 6
status: done
priority: low
depends_on: [P6-05, P6-01]
adr: ["0011"]
lessons: [L-060]
owner: ""
---

# P6-22 — Portfolio items in list_recent_changes

## Goal
Let `list_recent_changes` include epics and other portfolio items (D-91), so "what changed in this project this week"
covers the portfolio level too.

## Scope
- Add the portfolio item types P6-01 settles on to the tool's `asset_type` values and its batched query, with the same
  bounded window, scope predicate and recheck as the work-item types.
- Keep one request for all types and per-type cursors.

## Acceptance criteria
- [x] Epics appear in `list_recent_changes` for a project and a team (where epics have one), newest change first.
- [x] Contract, cost, negative-authorization and untrusted-text tests cover the new types; the cost stays declared.
- [x] `pnpm docs:tools` refreshed.

## Security notes
Portfolio items use their own scope strategy (checked by the compiler); no new route.

## Lessons applied
- L-060 — Bound time and history before the request.

## Docs to update
- docs/reference/tools.md (generated), docs/reference/tool-catalogue.md

## Notes
- Built per D-91 (b), owner decision 2026-10-27: `asset_type` accepts `Epic`; epics use the same `Scope` tree and
  `Team` filters as the work-item types (as `list_portfolio_items`), their own field set (`epicFields`) and row
  (`epicRow`, with `category`). When an instance's Epic has no `Team`, epics are left out of a team view with a note.
- **Live verification of epics in recent changes is pending**: the owner runs `pnpm test:live`.

## Out of scope
- Portfolio listing tools themselves (P6-01).
