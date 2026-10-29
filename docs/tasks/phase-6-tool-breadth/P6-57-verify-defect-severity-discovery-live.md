---
id: P6-57
title: Verify the defect priority and severity read live
phase: 6
status: done
priority: low
depends_on: [P6-30, P6-27]
adr: []
lessons: [L-148, L-033]
owner: ""
---

# P6-57 — Verify the defect priority and severity read live

## Goal
`defect_triage` reads `Priority.Name`, `Priority.Order` and one metadata-discovered severity attribute for the defects of its
page ([P6-30](P6-30-defect-priority-severity-triage.md), D-149). The paths and the discovery rule were verified on the synthetic
world only (L-148).

## Scope
- On a sandbox, run `defect_triage` against defects with and without a priority and a severity, with a relation-typed and a
  text-typed severity attribute, and with two severity-like attributes.
- Record shapes and counts only in docs/RESEARCH.md; fix the discovery rule if a real instance differs.

## Outcome (2026-10-29)
Run on the read-only tenant instead of a sandbox (reads only). The live check found the read failing on every page with more than
50 defects (an `ID in` filter over the compiler's caller bound); fixed by marking the server-built OID list trusted, with a
70-defect regression test that fails without the fix. Live after the fix: priority read, severity read (one relation-typed
severity attribute). Text-typed and two-candidate severity remain verified on fixtures only; no sandbox instance has them.

## Acceptance criteria
- [x] `Priority.Order` is accepted as a path and orders like the instance's list (path live; ordering by rank on fixtures).
- [x] A relation severity (`<name>.Name`) and a text severity are both shown; two candidates read none and say so (relation live; text and two candidates on fixtures).
- [x] Findings recorded with the date; no tenant names, ids or values (docs/RESEARCH.md).

## Security notes
The attribute name must stay out of every output (THREAT_MODEL A12).

## Lessons applied
- L-148
- L-033

## Docs to update
- docs/RESEARCH.md.

## Out of scope
- Other reports.
