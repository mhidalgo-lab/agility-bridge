---
id: P6-03
title: Quality views (tests, regression assets, defects)
phase: 6
status: done
priority: medium
depends_on: [P2-17, P6-09]
adr: ["0012"]
lessons: [L-035, L-155, L-292, L-293, L-294, L-295]
owner: ""
---

# P6-03 — Quality views (tests, regression assets, defects)

> Refined 2026-10-27 (tasks/README rule 7): recipes ride on the P6-09 resource manifest; typed tool decided against by default (D-95).

## Goal
Cover test and defect questions mostly through existing tools, adding a typed tool only where it pays off.

## Scope
- Two recipe resources (manifest entries in `packages/core/src/recipes/quality.ts`, nothing else touched in the manifest):
  `agility-bridge://recipes/tests-and-defects` (tests of a backlog item, tests by status, tests without status, open and
  recently closed defects, defects by priority, unowned defects, defects of a sprint) and
  `agility-bridge://recipes/regression-assets` (regression tests, test sets and the tests inside one; regression plans and
  suites by the same pattern after `list_asset_types`). Both are served through `query_assets` and `describe_asset_type`.
- The example calls live as data next to the text (the text is rendered from them), so tests compile every one through the
  real query compiler against the committed metadata snapshot and a recipe cannot rot.
- Decide (L-155) whether a typed tool such as test status for a backlog item is worth adding. Default: no (D-95).
- Live verification of the examples for types the tenant has (tests, defects); regression plans, suites, regression tests and
  test sets are absent there, so they are a recorded gap with a follow-up ([P6-25](P6-25-verify-regression-recipes-sandbox.md)).

## Acceptance criteria
- [x] Both recipe resources are listed and readable exactly when `query_assets` and `describe_asset_type` are allowed, and
      refused with no upstream call otherwise; the generic resource tests cover them.
- [x] Every example call in every recipe validates through the real query compiler against the metadata snapshot (test).
- [x] The recipe text carries no instance words and every example is rendered from the tested data.
- [x] Live: each example for tests and defects runs against the read-only tenant through the guarded suite (counts and shapes
      only); absent types are recorded as a gap with a follow-up task.
- [x] Typed-tool decision recorded in the tool catalogue (D-95); resource reference, tool catalogue and task index regenerated.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-035 — Validate at the domain level before calling upstream.
- L-155 — Keep the tool count small.

## Docs to update
- docs/reference/tool-catalogue.md (decision and the two recipe URIs)
- docs/reference/resources.md (generated)
- docs/LESSONS-LEARNED.md, docs/pending-decisions/phase-6.md

## Out of scope
- Anything not listed under Scope.
