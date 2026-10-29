---
id: P7-46
title: "URL-mode elicitation for the approval page"
phase: 7
status: todo
priority: low
depends_on: [P7-13, P7-12]
adr: ["0013"]
lessons: [L-156]
owner: ""
---

# P7-46 — URL-mode elicitation for the approval page

> Filed by [P7-13](P7-13-approval-page-e2e-url-elicitation.md). Refine scope and acceptance criteria before starting.

## Goal
A client that declares `elicitation.url` (MCP 2025-11) can open the approval page itself, instead of the person copying a link out of the pending answer.

## Scope
- Check the clients of the P7-12 matrix (and any new ones) for a declared `elicitation.url` capability; record which declare it in the client compatibility reference.
- If one does: the pending answer also asks the client to open the link (URL mode) when the capability is declared, and stays a plain link otherwise; the link, its page and every check of the page are unchanged.
- Tests: a client that declares it gets the URL request, a client that does not gets today's answer; the URL is the same-origin approval link and never carries the change.

## Acceptance criteria
- [ ] Declared capability recorded per client, or a recorded decision that none declares it yet.
- [ ] If built: tests for both capability cases, no change to the page's authorization.

## Security notes
THREAT_MODEL A13, T31: the link is the same one-use, signed-in-person-only page; URL mode must not make an approval possible without that page.

## Lessons applied
- L-156 — Plan write approval for clients that cannot elicit.

## Docs to update
- docs/reference/client-compatibility.md
- docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
