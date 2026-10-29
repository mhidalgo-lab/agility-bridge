---
id: P7-13
title: Approval page in the browser suites, URL-mode elicitation and a non-eliciting client on staging
phase: 7
status: todo
priority: medium
depends_on: [P7-02, P7-04]
adr: ["0013"]
lessons: [L-106, L-156]
owner: ""
---

# P7-13 — Approval page in the browser suites, URL-mode elicitation and a non-eliciting client on staging

> Filed by P7-02 ([approval page](P7-02-approval-page.md)). Refine scope and acceptance criteria before starting.

## Goal
The parts of the approval page that need a real browser, a real client or a deployment, which P7-02 could not verify on fakes.

## Scope
- Playwright: run the E2E server with write tools on and a test write tool, and cover `/admin/approve/<id>` (the change is shown whole, approve and decline, a stale sign-in is sent to sign in again and returns, another user's link is a 404, CSP and axe stay clean).
- The DAST (ZAP) scan reaches the page with the same server and finds nothing new.
- URL-mode elicitation (MCP 2025-11) for clients that declare `elicitation.url`: the pending answer also opens the link in the client; a plain link otherwise. Check which clients declare it (P7-12 matrix) before building.
- End to end over HTTP on staging with a client that cannot elicit (Copilot in JetBrains, or the MCP Inspector CLI): pending, approve on the page, repeat, applied once (needs P7-04 for a real tool and the writable sandbox).

## Acceptance criteria
- [ ] E2E spec for the approval page, run in CI (Chromium).
- [ ] The DAST scan covers the page; no new finding.
- [ ] URL-mode elicitation built, or a recorded decision that no client declares it yet.
- [ ] Staging run with a non-eliciting client recorded in the client compatibility reference.

## Security notes
THREAT_MODEL A13, T31.

## Lessons applied
- L-106 — Approval shows and binds the complete change.
- L-156 — Plan write approval for clients that cannot elicit.

## Docs to update
- docs/guide/write-tools.md
- docs/reference/client-compatibility.md

## Out of scope
- Anything not listed under Scope.
