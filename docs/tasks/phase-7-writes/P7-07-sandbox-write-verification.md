---
id: P7-07
title: Sandbox write verification
phase: 7
status: todo
priority: high
depends_on: [P7-02, P7-05, P7-06]
adr: ["0013"]
lessons: [L-044, L-051, L-112, L-125]
owner: ""
---

# P7-07 — Sandbox write verification

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Rehearse every write against the sandbox before writes are enabled anywhere.

## Scope
- Procedure: dry-run each tool, apply one per asset type, read back, repeat (no-op), conflict test, cleanup, disable writes; record evidence and read-lag observations.

## Acceptance criteria
- [ ] Evidence recorded in the verification notes; procedure documented for operators.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-044 — Round-trip what you create.
- L-051 — Expect read-after-write lag.
- L-112 — Rehearse writes in a sandbox before enabling them anywhere.
- L-125 — Keep live-verification evidence and recipes.

## Docs to update
- docs/dev/write-sandbox-test.md (new)

## Out of scope
- Anything not listed under Scope.
