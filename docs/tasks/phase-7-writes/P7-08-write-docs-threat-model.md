---
id: P7-08
title: Write documentation and threat-model update
phase: 7
status: review
priority: medium
depends_on: [P7-07]
adr: ["0013"]
lessons: [L-133, L-010]
owner: ""
---

# P7-08 — Write documentation and threat-model update

> Refined 2026-10-29 (tasks/README rule 7); the sandbox walkthrough stays with P7-07, so this task ends in `review`.

## Goal
Operators and users understand what writes do, how approval works per client, and the remaining risks, and every claim says what evidence stands behind it (fakes, or a real instance).

## Scope
Refined 2026-10-29 (all nine write tools are merged: P7-01 – P7-06). What can be written and checked now:
- `docs/guide/write-tools.md` as one complete operator and user guide: the nine tools with an approval-text example each, the enablement layers and how to switch them on (stdio, HTTP server, Worker, OAuth, workspace and grant lists, personal credentials), approval per client and protocol era, the approval page, `AB_WRITE_APPROVAL=off` (stdio only), limits, audit, conflicts, no-ops, read lag, and what is unverified until P7-07. An operator checklist for enabling writes safely.
- A per-client approval-channel table in `docs/reference/client-compatibility.md`, from the P0-07 and P5-06 facts; a client not run with writes says *not yet run*.
- THREAT_MODEL statuses for T31, A2, A6 and A13 with evidence (tests and docs), honest about what is verified on fakes only.
- Every documented command runs (docs-snippet tests, L-133); generated references refreshed.
Documentation only: a doc that exposes a bug becomes a follow-up task, not a fix here.

## Acceptance criteria
- [x] The guide covers the items above; its commands are doc-tested and every `AB_` name in it exists.
- [x] The client reference has the per-client approval table with evidence and *not yet run* marks.
- [x] THREAT_MODEL T31, A2, A6 and A13 rows have status and evidence, with the fakes-only residual named.
- [x] Mismatches between the docs and the code found while writing are filed as tasks (P7-24, P7-25), not fixed here.
- [ ] Moved to [P7-07](P7-07-sandbox-write-verification.md): the guide walked through on the staging deployment against a writable sandbox, and every sandbox-verified fact copied into the guide and RESEARCH §1.5 (the guide lists each as *unverified*).

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-133 — Execute the documentation.
- L-010 — Every security claim needs evidence.

## Docs to update
- docs/guide/write-tools.md
- docs/THREAT_MODEL.md
- docs/reference/client-compatibility.md
- docs/guide/configuration.md (a stale line about write tools)

## Out of scope
- Anything not listed under Scope.
