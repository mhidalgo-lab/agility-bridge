---
id: P7-51
title: URL-mode elicitation on 2026-07-28 requests
phase: 7
status: todo
priority: low
depends_on: [P7-46, P7-12]
adr: ["0013"]
lessons: [L-482]
owner: ""
---

# P7-51 — URL-mode elicitation on 2026-07-28 requests

> Filed by [P7-46](P7-46-url-mode-elicitation.md) (D-345). Refine scope and acceptance criteria before starting.

## Goal
Claude Code and Copilot CLI (2026-07-28) are asked to open the approval page's link too, not only connections that can be pushed to.

## Scope
- On a 2026-07-28 request whose client declared `elicitation.url` and whose channel is the page: answer `input_required` with an `elicitUrl` input request carrying the page's link, then, on the repeated call, return the page's pending answer (or apply the change when the person already approved on the page).
- Keep the link, the page and every check of the page unchanged; the sealed state binds the change like the form flow's, and an `accept` is never read as approval.

## Acceptance criteria
- [ ] Tests for a client that declares `url`, one that does not, a repeat before and after the page decision, and a tampered or expired state.
- [ ] *owner / live:* behaviour of the real clients confirmed (P7-12).

## Security notes
THREAT_MODEL A13, T31: the same one-use, signed-in-person-only page.

## Lessons applied
- L-482 — A convenience in front of an out-of-band approval carries the link and nothing else.

## Docs to update
- docs/reference/client-compatibility.md
- docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
