---
id: P3-06
title: Worker test suite (workerd)
phase: 3
status: todo
priority: medium
depends_on: [P3-02]
adr: []
lessons: [L-121, L-123]
owner: ""
---

# P3-06 — Worker test suite (workerd)

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Everything that runs on Workers is tested on workerd, not only on Node.

## Scope
- Vitest Workers pool with local D1, rate-limit and Durable Object simulators.
- Authorization matrix (P2-12) and storage contract on workerd; `waitUntil` audit writes; client IP handling.

## Acceptance criteria
- [ ] The suite runs in CI; per-test database isolation (no shared-state flakes).

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-121 — Negative authorization is first-class.
- L-123 — Make property tests meaningful and deterministic.

## Docs to update
- docs/dev/testing.md

## Out of scope
- Anything not listed under Scope.
