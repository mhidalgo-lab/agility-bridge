---
id: P9-02
title: External security review
phase: 9
status: todo
priority: high
depends_on: [P9-01]
adr: []
lessons: [L-010]
owner: ""
---

# P9-02 — External security review

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
An independent reviewer examines the riskiest areas before 1.0.

## Scope
- Call for reviewers with scope (OAuth, approval and write path, query compiler, access model, key handling, panel), safe-harbour terms and the reviewer map; triage and fix findings with regression tests.

## Acceptance criteria
- [ ] Review summary published; every finding fixed or accepted.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-010 — Every security claim needs evidence.

## Docs to update
- docs/security/call-for-reviewers.md (new)
- SECURITY.md

## Out of scope
- Anything not listed under Scope.
