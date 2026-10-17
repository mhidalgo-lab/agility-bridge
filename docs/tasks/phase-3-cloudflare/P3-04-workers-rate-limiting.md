---
id: P3-04
title: Rate limiting on Workers
phase: 3
status: todo
priority: medium
depends_on: [P3-01]
adr: ["0010"]
lessons: [L-080, L-081, L-099]
owner: ""
---

# P3-04 — Rate limiting on Workers

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Edge rate limits that behave predictably across isolates.

## Scope
- Per-isolate buckets plus the Rate Limiting binding as a backstop.
- Optional shared limiter (Durable Object) for authentication failures and sign-in; policy when the binding is missing or throws.

## Acceptance criteria
- [ ] Tests for binding failure (documented fail-open/closed) and auth-failure throttling.

## Security notes
THREAT_MODEL T1, T20.

## Lessons applied
- L-080 — Decide fail-open vs fail-closed for each control, and test it.
- L-081 — Per-process limits are not deployment-wide.
- L-099 — The Rate Limiting binding is a backstop.

## Docs to update
- docs/guide/cloudflare-limits.md

## Out of scope
- Anything not listed under Scope.
