---
id: P7-12
title: What real clients render of the approval text
phase: 7
status: todo
priority: medium
depends_on: [P7-01]
adr: ["0013"]
lessons: [L-106, L-385]
owner: ""
---

# P7-12 — What real clients render of the approval text

> Filed by P7-01 ([write framework](P7-01-write-framework.md)). Refine scope and acceptance criteria before starting.

## Goal
The approval text is complete and readable in the clients people use, and the size limits are right for them.

## Scope
- With the framework's test-only tool (or the first real tool of P7-04), call a dry run and a real write from VS Code, Claude Code, Copilot CLI and JetBrains and record how each renders the elicitation message: line breaks, the untrusted-data envelope lines, long values, the change id, and whether any truncates.
- Tune the text and the limits (D-162) from what was seen; never allow a client to truncate silently (refuse instead).

## Acceptance criteria
- [ ] Matrix of clients with screenshots or transcripts in the client compatibility reference.
- [ ] A change near each limit shown whole, or refused, in every client.
- [ ] Limits and text adjusted if a client cut or hid a line; decision D-162 updated.

## Security notes
THREAT_MODEL T31, A2.

## Lessons applied
- L-106 — Approval shows and binds the complete change.
- L-385 — What the person reads must be byte for byte what is sent.

## Docs to update
- docs/reference/client-compatibility.md
- docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
