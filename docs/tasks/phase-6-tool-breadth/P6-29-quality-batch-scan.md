---
id: P6-29
title: Quality scan over a sprint or epic
phase: 6
status: todo
priority: low
depends_on: [P6-07]
adr: ["0015"]
lessons: [L-033, L-037, L-114]
owner: ""
---

# P6-29 — Quality scan over a sprint or epic

## Goal
Score many backlog items in one call (`work_item_quality` scores one), so a refinement session can see which items of a
sprint or epic need work first.

## Scope
- An input for `work_item_quality` (or a sibling report) that takes a sprint or an epic and scores its stories and defects
  from one batched read of their text fields, with the same versioned rubric (D-103) and the same score range for what
  could not be assessed.
- Cost declared at the worst case of the batch; a cap on items per call with `partial` and a note when more exist.

## Acceptance criteria
- [ ] Items of a sprint and of an epic are scored with the same results as one-by-one calls on the same data.
- [ ] More items than the cap are reported as `partial`, never scored from a partial read as if complete.
- [ ] Cold cost, negative authorization and poisoned-text tests as for the other reports; `pnpm docs:tools` refreshed.

## Security notes
THREAT_MODEL T3, A1: scope on every row; descriptions are untrusted data.

## Lessons applied
- L-033 — Never turn missing data into zeros or confident claims.
- L-114 — Declared costs cover the worst case.

## Docs to update
- docs/reference/tools.md (generated), docs/reference/tool-catalogue.md

## Out of scope
- Changing the rubric (its version moves only with its criteria).
