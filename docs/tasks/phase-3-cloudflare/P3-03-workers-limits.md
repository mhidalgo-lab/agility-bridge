---
id: P3-03
title: Workers limits presets and per-call budgets
phase: 3
status: review
priority: high
depends_on: [P3-01]
adr: ["0010"]
lessons: [L-049, L-097, L-101, L-115]
owner: ""
---

# P3-03 — Workers limits presets and per-call budgets

> Refined 2026-10-22 (tasks/README rule 7).

## Goal
Tool calls fit the plan they run on, and tools that cannot fit are hidden.

## Scope
- `AB_PLAN=free|paid` on the Worker (default `free`) picks the defaults: call budget 45 / 1,000 Agility requests,
  response cap 512 KiB / 8 MiB (ADR-0010); concurrency per call ≤ 6 (P3-01).
- On `free`, the plan is also a **ceiling**: no workspace or grant limit raises the call budget above 45 or the
  response cap above 512 KiB (the Free plan allows 50 subrequests per request), and `AB_CALL_BUDGET` or
  `AB_LIMITS_MAX_RESPONSE_BYTES` above them stop the boot with a message naming the setting. `assembleServer` takes
  the ceilings; Node keeps none.
- Already in place, now tested on the Worker: tools whose declared cost exceeds the caller's budget are not listed or
  callable (`maxCost`, L-115); the Agility requests a call used are in its audit row (`agility_requests`), never in
  headers (L-101).

## Acceptance criteria
- [x] Worker tests: on the Free preset every tool fits (the largest declares 24) and the audit row records the
      requests used; with a smaller budget the tools above it are absent from `tools/list` and refused when called; a
      workspace limit above the Free ceiling is capped; out-of-plan settings stop the boot.
- [x] Unit tests for the presets and the plan check.
- [x] `docs/guide/cloudflare-limits.md` (new): plans, presets, ceilings, what is hidden, where usage shows.

## Security notes
THREAT_MODEL T5, A10.

## Lessons applied
- L-049 — Cap bytes before parsing.
- L-097 — Design for the Free plan's limits, not its tolerance.
- L-101 — Count budgets in audit records, not headers.
- L-115 — Hide what cannot fit.

## Docs to update
- docs/guide/cloudflare-limits.md (new)

## Out of scope
- Workers rate limiting (P3-04); CPU measurements (P3-10).
