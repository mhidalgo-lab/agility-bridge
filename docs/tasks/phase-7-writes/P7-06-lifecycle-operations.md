---
id: P7-06
title: "Lifecycle operations: close and reopen"
phase: 7
status: review
priority: medium
depends_on: [P7-04]
adr: ["0013"]
lessons: [L-105, L-108]
owner: "claude"
---

# P7-06 — Lifecycle operations: close and reopen

> Scope refined 2026-10-29 (tasks/README rule 7): built and tested on fakes that model the documented operation request;
> operation names and the request shape are *unverified* in RESEARCH §1.5 and go to the sandbox run (P7-07).

## Goal
Close and reopen work items as destructive, separately enabled operations.

## Scope
- **Two tools** (D-185), `close_asset` and `reopen_asset`, kind `destructive` (MCP `destructiveHint`), group `writes`, built with
  `defineWriteTool`. Each is its own name in the workspace and grant tool lists, so an owner can enable reopening without
  closing and the reverse. Input: `asset` (number or OID) plus the framework's `dry_run` and `confirm`; no operation name
  from the caller.
- **Transport** (D-187): an Agility *operation*, `POST rest-1.v1/Data/<Type>/<id>?op=<Name>` with no body, through the
  existing single-attempt `restWrite`. The name is the first one the type's `meta.v1` operations offer (close:
  `QuickClose`, `Close`, `Inactivate`; reopen: `Reactivate`); a type with none is refused before approval, and the name
  is part of the approval text and the hash.
- **Targets**: Story, Defect, Task, Test, Epic inside the workspace's projects; deleted, template and broken-down items are
  refused.
- **Children** (D-186): closing an item with open child items (tasks and tests of a story or defect; epics, stories and
  defects under an epic) is refused before approval with the count; the approval shows `OpenChildren 0 -> 0` so the
  hash binds "no open children", and a child that appears before the send is a conflict.
- **No-op and conflict** (D-188): closing a closed item and reopening an open one is a no-op (no approval, no audit, no
  request); the re-read treats a target already in the new state as a no-op and one that was deleted, removed or whose
  open children changed as `AB_WRITE_CONFLICT`.
- Catalogue: both tools join `CORE_TOOLS`; tool reference regenerated; `tools/list` budgets hold.

## Acceptance criteria
- [x] Operation availability and children are checked before approval; tests for each operation, no-op, conflict and refusal.
- [x] The exact operation request is asserted (path, `op`, empty body, content type).
- [x] Negative authorization: tool absent unless enabled at each layer, a grant naming only one tool cannot call the other, a
  denied type and an out-of-scope target are refused with no write and no approval.
- [x] `destructive` annotations checked; every group under 72 KB and fewer than 40 tools with every group on.
- [x] Docs: write-tools guide, tool reference, RESEARCH (unverified operations), THREAT_MODEL, decisions D-185..D-188.
- [ ] *Sandbox (P7-07):* the real operation names per type, whether `QuickClose` cascades to children, what the validators
  refuse, and the response shape (follow-ups P7-22 and P7-23).

## Security notes
THREAT_MODEL A2.

## Lessons applied
- L-105 — Writes are a separate product.
- L-108 — Validate fully, then ask, then re-check, then apply once.

## Docs to update
- docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
