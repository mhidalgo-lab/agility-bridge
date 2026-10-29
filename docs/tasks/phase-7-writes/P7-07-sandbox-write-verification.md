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

## Wave-2 items from P7-05 (unverified request shapes)
- [ ] `create_work_item`: `POST /Data/<Type>` for Story, Defect, Task, Test, Epic with `Name`, `Description`, `Estimate` or `DetailEstimate`, `Scope`, `Priority`, `Super` or `Parent`; which attributes Agility requires without a default; whether `Scope` is derived from `Parent` for a Task or Test; what `rest-1.v1/New` returns (D-180); the response shape and the read lag.
- [ ] `update_fields`: `Name`, `Description`, `Estimate`, `DetailEstimate` and `Priority` sets; whether `Description` HTML written as escaped paragraphs is kept as sent or re-sanitised, and how `<br>` renders (D-182).
- [ ] The duplicate check (D-179): `CreatedBy` and `CreateDateUTC` are readable and sortable on every type, and a new item is visible to `query.v1` in time for a repeat within seconds.

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

## Lifecycle items from P7-06 (unverified operation shapes)
- [ ] `close_asset`: which of `QuickClose`, `Close`, `Inactivate` each type has and which is right; does `QuickClose` close open tasks and tests (D-186, P7-22); what the validators refuse.
- [ ] `reopen_asset`: `Reactivate` per type; refused when the parent is closed? (P7-23).
- [ ] The response of an operation with no body, and the read lag before the state shows (L-051).

## Items moved from P7-08 (documentation walkthrough)
- [ ] Walk the [write tools guide](../../guide/write-tools.md) on staging against the sandbox: every command, the enablement steps for stdio and for a device-token HTTP connection, and the operator checklist.
- [ ] Copy each sandbox-verified fact into the guide's "What is unverified" list (remove what is now verified, with date and instance version) and into RESEARCH §1.5; update THREAT_MODEL T31, A2, A6 from "verified on fakes only" where the sandbox shows it.
- [ ] Record per client, in the client compatibility reference, which of the *not yet run* write rows were run with a real write tool.
## Items from the Phase 7 review (P7-09, hypotheses)
- [ ] `assign_owners`: are `Owners` and `Owners.Name` returned in the same order for a multi-valued relation? If not, resolve names by reading the `Member` rows for the OIDs (review L9). Also: can an inactive member who is still an owner be removed (they are not found by name today), and does a renamed member give a false conflict (compare by OID)? (review Q-10)
- [ ] `add_comment`: is `Expression.Content` rendered as HTML by Agility? If so, send HTML-escaped paragraphs like descriptions (D-182) instead of raw text, since a comment holding `<a href=...>` would become live markup for other people (review L10). Also how `Content` is stored (escaping, newlines) against the 10-minute no-op comparison.
- [ ] `close_asset`: does `QuickClose` close open children while plain `Close` is refused? If it cascades, prefer `Close` or keep the refusal (D-191); the cascade question also decides P7-22.
- [ ] The response of an operation with no body: confirm that a 2xx with an empty body is what Agility sends (the pipeline reports it as applied, D-198, L-404).
