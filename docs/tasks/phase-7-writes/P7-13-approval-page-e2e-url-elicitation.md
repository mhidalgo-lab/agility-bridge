---
id: P7-13
title: Approval page in the browser suites, URL-mode elicitation and a non-eliciting client on staging
phase: 7
status: review
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
Built now (on fakes, in the existing browser suites):
- `e2e/writes.ts`: a throwaway server with `AB_WRITE_TOOLS=on`, a personal credential, a workspace that allows writes and names `update_status`, a grant for the owner with that tool and a device token. A client without elicitation calls `update_status` over HTTP and gets the pending answer with the link; that link is the page under test.
- Playwright spec `e2e/approval.spec.ts` (Chromium, 1280 px and 320 px): the change is shown whole (target, every field old and new, change id), approve and decline answer and nothing is left to approve twice, a stale sign-in is sent to sign in again and returns to the page, another person's link and an unknown id are the same 404, a tampered hash approves nothing, CSP and axe stay clean, no horizontal scroll.
- The ZAP baseline (`e2e/zap.ts`) gets a fourth run that starts at the approval link with the owner's session; no new finding.

Not doable now (left as unchecked items):
- URL-mode elicitation (MCP 2025-11) for clients that declare `elicitation.url`: no client of the P7-12 matrix is known to declare it, so there is nothing to test it against; follow-up P7-46 records the check and builds it when one does.
- A staging run with a client that cannot elicit: needs a deployment and the writable sandbox (P7-10, P7-07). The synthetic Agility serves no write endpoint, so the browser suites stop at the recorded approval (the repeat that applies it is covered by the unit tests and by P7-07).

## Acceptance criteria
- [x] E2E spec for the approval page, run in CI (Chromium).
- [x] The DAST scan covers the page; no new finding.
- [ ] URL-mode elicitation built, or a recorded decision that no client declares it yet (follow-up P7-46).
- [ ] Staging run with a non-eliciting client recorded in the client compatibility reference (P7-10, P7-07).

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
