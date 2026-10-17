---
id: P4-08
title: Browser E2E and DAST baseline
phase: 4
status: todo
priority: medium
depends_on: [P4-04]
adr: []
lessons: [L-123, L-126]
owner: ""
---

# P4-08 — Browser E2E and DAST baseline

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Catch what unit tests cannot in the panel.

## Scope
- Playwright flows for sign-in, every screen and the setup link; an OWASP ZAP baseline scan; both scheduled and on demand; Medium/High findings fail.

## Acceptance criteria
- [ ] Browser E2E covers every screen delivered by P4-04 – P4-07.
- [ ] Both workflows green on `main`; explicit timeouts for browser steps.

## Security notes
THREAT_MODEL T13.

## Lessons applied
- L-123 — Make property tests meaningful and deterministic.
- L-126 — Browser E2E and a DAST scan find what unit tests miss.

## Docs to update
- docs/dev/testing.md

## Out of scope
- Anything not listed under Scope.
