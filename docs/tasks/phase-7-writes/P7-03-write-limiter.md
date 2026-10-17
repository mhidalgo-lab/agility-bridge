---
id: P7-03
title: Deployment-wide write limiter
phase: 7
status: todo
priority: high
depends_on: [P7-01]
adr: ["0010"]
lessons: [L-080, L-081, L-111]
owner: ""
---

# P7-03 — Deployment-wide write limiter

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Write limits hold across processes and isolates.

## Scope
- Per-grant write rate (default 20/hour) enforced through a shared limiter (Durable Object on Workers, storage counters on Node); fails closed.

## Acceptance criteria
- [ ] Concurrency tests across isolates; limiter outage refuses writes.

## Security notes
THREAT_MODEL T31, A2.

## Lessons applied
- L-080 — Decide fail-open vs fail-closed for each control, and test it.
- L-081 — Per-process limits are not deployment-wide.
- L-111 — Write limits are deployment-wide.

## Docs to update
- docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
