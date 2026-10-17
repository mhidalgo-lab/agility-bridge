---
id: P4-06
title: Connect page with client snippets
phase: 4
status: todo
priority: medium
depends_on: [P4-04]
adr: ["0016"]
lessons: [L-023, L-026]
owner: ""
---

# P4-06 — Connect page with client snippets

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
A user picks a client and copies a working configuration for their workspace.

## Scope
- Snippets for every primary client (local and remote), secrets kept out of plain text where the client allows it; token issued on the same page.

## Acceptance criteria
- [ ] Each snippet matches the verified form in client-compatibility.md.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-023 — SDK conformance does not prove client compatibility.
- L-026 — Configure stdio servers through the client, never through flags.

## Docs to update
- docs/guide/clients.md

## Out of scope
- Anything not listed under Scope.
