---
id: P6-25
title: Verify the regression and test-set recipes on the writable sandbox
phase: 6
status: todo
priority: low
depends_on: [P6-03, P7-07]
adr: ["0012"]
lessons: [L-292, L-293]
owner: ""
---

# P6-25 — Verify the regression and test-set recipes on the writable sandbox

## Goal
Close the gap P6-03 could not: the read-only tenant has no regression tests, plans, suites or test sets, so those recipe
examples were only compiled offline (D-97). Prove them on data, and add validated examples for plans and suites.

## Scope
- On the writable sandbox (P7-07): create a regression plan, suite, regression tests and a test set with tests, run every
  example of `recipes/regression-assets` and compare the rows with what was created.
- Record the real relation names between plan, suite and regression test (`describe_asset_type`) and add examples for plans
  and suites to the recipe, with the snapshot extended so the compile test covers them.
- Evidence in the template of `docs/dev/verification.md`, sandbox assets only.

## Acceptance criteria
- [ ] Every regression-assets example returns the created assets (and only them) on the sandbox.
- [ ] Plans and suites have examples that the compile test validates.
- [ ] The tenant inventory line for these types is updated if it was wrong.

## Security notes
Sandbox only; no tenant content from the third-party tenant is used or recorded.

## Lessons applied
- L-292 — A recipe is data the tests run.
- L-293 — A recipe over an optional type starts with "does it exist here".

## Docs to update
- docs/dev/verification.md, docs/reference/resources.md (generated)

## Out of scope
- Any write tool; a typed regression tool (P6-26).
