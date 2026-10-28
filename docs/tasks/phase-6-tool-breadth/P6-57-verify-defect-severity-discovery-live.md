---
id: P6-57
title: Verify the defect priority and severity read live
phase: 6
status: todo
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

## Acceptance criteria
- [ ] `Priority.Order` is accepted as a path and orders like the instance's list.
- [ ] A relation severity (`<name>.Name`) and a text severity are both shown; two candidates read none and say so.
- [ ] Findings recorded with the date; no tenant names, ids or values.

## Security notes
The attribute name must stay out of every output (THREAT_MODEL A12).

## Lessons applied
- L-148
- L-033

## Docs to update
- docs/RESEARCH.md.

## Out of scope
- Other reports.
