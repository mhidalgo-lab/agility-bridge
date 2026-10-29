---
id: P6-60
title: Fix the flaky tests behind the CI reruns
phase: 6
status: done
priority: high
depends_on: []
adr: []
lessons: [L-321, L-322, L-104, L-380, L-381, L-382]
owner: ""
---

# P6-60 — Fix the flaky tests behind the CI reruns

## Goal
Task PRs needed reruns for tests their changes did not touch. Find each root cause and fix it in the test setup, without
skipping a test or weakening an assertion.

## Scope
- Worker tests: the bundle was rebuilt into one directory by four parallel files (empty or half-written script).
- Worker tests: audit rows written through `waitUntil` were awaited for about a second.
- OAuth abuse suite: floods that straddled a fixed counter window.
- `storage-sqlite` tests: real-file fsync cost on the Windows runner against the 5 s default timeout.

## Acceptance criteria
- [x] One build of the Worker bundles, before any test file (`apps/worker/test/global-setup.ts`).
- [x] `waitUntil` results are awaited on the condition with a deadline (`apps/worker/test/wait.ts`).
- [x] The abuse suite starts its floods at the start of a counter window.
- [x] `storage-sqlite` sets a timeout that fits the Windows runner; the reason is in the config.
- [x] Lessons L-380 to L-382.
- [x] Repeated runs of the affected files pass.

## Security notes
Test-only change; no product code.

## Lessons applied
- L-321, L-322, L-104

## Docs to update
- docs/LESSONS-LEARNED.md

## Out of scope
- Failures that were real regressions of their PRs (logging inventory, lesson numbering, evals baseline, cf-migrate).
