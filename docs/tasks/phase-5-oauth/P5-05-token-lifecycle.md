---
id: P5-05
title: Token lifecycle and refresh concurrency
phase: 5
status: todo
priority: high
depends_on: [P5-01]
adr: ["0009"]
lessons: [L-029, L-094]
owner: ""
---

# P5-05 — Token lifecycle and refresh concurrency

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Tokens rotate safely even when clients refresh in parallel.

## Scope
- Access 1 h, refresh 30 d (configurable); rotation with a reuse window (default 30 s, 0–120); reuse outside the window revokes the device; device caps; revocation checks on every refresh.

## Acceptance criteria
- [ ] Parallel-refresh test (several concurrent refreshes from one client) keeps the device; replay after the window revokes it.
- [ ] The reuse window's successor tokens are kept encrypted, never in plaintext.

## Security notes
THREAT_MODEL T9, T15.

## Lessons applied
- L-029 — Clients refresh OAuth tokens concurrently.
- L-094 — Follow the OAuth details clients rely on.

## Docs to update
- docs/guide/oauth-how-it-works.md (new)

## Out of scope
- Anything not listed under Scope.
