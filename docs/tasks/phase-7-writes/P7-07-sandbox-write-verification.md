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

## Prerequisite
- A writable Agility sandbox (Digital.ai trial or similar) with reader and writer members and synthetic seed data
  (D-01: the Phase 0 tenant is read-only and must never be written to). The write probes and quota measurements deferred
  from P0-06 run here first.

## Scope
- Procedure: dry-run each tool, apply one per asset type, read back, repeat (no-op), conflict test, cleanup, disable writes; record evidence and read-lag observations.

## Acceptance criteria
- [ ] Evidence recorded in the verification notes; procedure documented for operators.

## Wave-1 items from P7-04 (unverified request shapes)
Check each against the sandbox and fix the tool's `send` (not its plan) if a shape differs; record the evidence in RESEARCH §1.5.
- [ ] `update_status`: `Status` set on Story, Defect, Task, Test and Epic; a status of another team's workflow is refused by Agility or accepted?
- [ ] `assign_owners`: `act="add"` and `act="remove"` on `Owners` in one document.
- [ ] `move_to_sprint`: `Timebox` set; a sprint of another schedule refused by Agility?
- [ ] `add_comment`: a bare `Expression` with `Content` and `Mentions` (does it need a `Conversation` through `BelongsTo`; are `Author` and `AuthoredAt` set by the server; plain text or HTML; the read side shows it as a comment of the item).
- [ ] `log_effort`: `Actual` with `Value`, `Date`, `Member`, `Workitem` (are `Scope`, `Team`, `Timebox` derived; does the item's `Actuals` total change at once).
- [ ] The response of each write (`<Asset id="Type:id:moment">`?) and the read lag before the change is visible (L-051).
- [ ] The comment and effort no-op rules (identical latest entry) against how Agility stores text and dates.

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
