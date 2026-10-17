---
id: P1-12
title: Test harness (fixtures, contract tests, probes, live suite)
phase: 1
status: todo
priority: high
depends_on: [P1-01, P0-12]
adr: []
lessons: [L-003, L-053, L-114, L-122, L-123]
owner: ""
---

# P1-12 — Test harness (fixtures, contract tests, probes, live suite)

## Goal
Make correct behaviour cheap to prove: fixtures from real (sanitised) responses, contract tests, hostile probes, cost tests and a protected live suite.

## Scope
- Injected-fetch fixture server built from the P0-06 captures.
- MCP contract tests: `tools/list` snapshot including size and count.
- Poisoned-string probe suite for every output path; hostile upstream fixtures (foreign-scope rows, forged ids, malformed payloads, empty and permission-limited responses).
- Seeded, replayable property tests; worst-case cost tests.
- Read-only live suite on the protected environment (nightly and on demand); metadata drift check.

## Acceptance criteria
- [ ] The harness is documented and used by the core tests; tool tasks (P1-07 onwards) add their contract and probe tests on it.
- [ ] The probe suite fails when any tool leaks unenveloped upstream text (proved by a deliberately broken tool in a test).
- [ ] The live suite runs green from `main`.

## Security notes
Fixtures sanitised (THREAT_MODEL T8).

## Lessons applied
- L-003 — Plan live verification from Phase 0, not at the end.
- L-053 — Snapshot the upstream schema and detect drift.
- L-114 — Declared costs cover the worst case.
- L-122 — Feed tools hostile upstream data.
- L-123 — Make property tests meaningful and deterministic.

## Docs to update
- docs/dev/testing.md (new)
- docs/dev/verification.md

## Out of scope
- Anything not listed under Scope.
