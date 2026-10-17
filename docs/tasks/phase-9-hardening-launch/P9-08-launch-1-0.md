---
id: P9-08
title: Launch checklist and 1.0.0
phase: 9
status: todo
priority: high
depends_on: [P9-02, P9-03, P9-04, P9-05, P9-06, P9-07]
adr: []
lessons: [L-023, L-135]
owner: ""
---

# P9-08 — Launch checklist and 1.0.0

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Ship 1.0 with every gate checked.

## Scope
- One launch checklist: functionality, real-client matrix, security evidence, documentation, provenance, rollback; release notes; announcement.

## Acceptance criteria
- [ ] Checklist signed off by the owner; v1.0.0 published and verified.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-023 — SDK conformance does not prove client compatibility.
- L-135 — README and docs are release artifacts.

## Docs to update
- README.md
- docs/ROADMAP.md

## Out of scope
- Anything not listed under Scope.
