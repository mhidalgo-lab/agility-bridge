---
id: P7-02
title: Out-of-band approval page
phase: 7
status: review
priority: high
depends_on: [P7-01, P4-02]
adr: ["0013"]
lessons: [L-106, L-156]
owner: ""
---

# P7-02 — Out-of-band approval page

> Refined 2026-10-29 (tasks/README rule 7). Built on fakes; what needs a browser suite, a real client or staging is
> P7-13, a list of open requests is P7-14.

## Goal
Clients that cannot elicit (2025-era clients over remote HTTP, such as Copilot in JetBrains as verified in P0-07, and mobile apps) can still have a person approve the exact change.

## Scope
- The `page` channel of the write pipeline (core `ApprovalChannelPort`, `ApprovalPrompt` now carries the workspace, the canonical mutation and the label): the pending answer `AB_WRITE_APPROVAL_PENDING` with a link to `/admin/approve/<id>` (D-163), stored as a short-lived `kv` record found by the signed-in person's own id (D-164).
- The page in the signed-in panel (`packages/admin-ui`, a normal screen: sessions, CSRF, Origin, CSP, layout): shows every field old and new, the item, the workspace and the change id; approve (recent sign-in required, else sign-in again) or decline; single use; ten minutes.
- The ledger: grants and denials bound to actor, workspace and change hash (D-165); the repeated call takes the grant (once) and the pipeline's re-read, intent audit and send follow as for any approval.
- Only for requests with a user behind the grant (D-166); admin audit rows for approve, decline and refusals.
- URL-mode elicitation and the real-client run: P7-13 (D-167). Owner decision D-12 (keep the page): built.

## Acceptance criteria
- [x] Phishing and forgery tests: another user, another workspace, another change, expired request, expired approval, replayed and double-submitted decisions, tampered hash, missing or wrong CSRF, cross-site post, malformed fields, stale sign-in, signed-out visitor.
- [x] The page shows the whole change escaped, under the panel CSP; the audit rows hold no value.
- [x] The agent's repeated call applies exactly once with the approved change; a decline is reported as declined.
- [ ] End to end over HTTP on staging with a client that cannot elicit (Copilot in JetBrains, or the MCP Inspector CLI), the Playwright and DAST suites over the page, and URL-mode elicitation: P7-13 (needs a real write tool and the writable sandbox).

## Security notes
THREAT_MODEL A13, T31.

## Lessons applied
- L-106 — Approval shows and binds the complete change.
- L-156 — Plan write approval for clients that cannot elicit.

## Docs to update
- docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
