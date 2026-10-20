---
id: P7-02
title: Out-of-band approval page
phase: 7
status: todo
priority: high
depends_on: [P7-01, P4-02]
adr: ["0013"]
lessons: [L-106, L-156]
owner: ""
---

# P7-02 — Out-of-band approval page

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Clients that cannot elicit (2025-era clients over remote HTTP, such as Copilot in JetBrains as verified in P0-07, and mobile apps) can still have a person approve the exact change.

## Scope
- `AB_WRITE_APPROVAL_PENDING` result with a short-lived link to `/approve/<id>` in the signed-in panel.
- The page shows the exact change and target; only the grant's own user can approve; CSRF and Origin checks; re-authentication when stale; single use; short expiry.
- The agent repeats the call; the ledger matches it to the approved mutation.
- URL-mode elicitation for clients that support it, plain link otherwise.
- Owner decision D-12 recorded (keep or drop).

## Acceptance criteria
- [ ] Phishing and forgery tests (other user, other change, expired, replayed); end-to-end over HTTP on staging with a client that cannot elicit (Copilot in JetBrains, or MCP Inspector CLI).

## Security notes
THREAT_MODEL A13, T31.

## Lessons applied
- L-106 — Approval shows and binds the complete change.
- L-156 — Plan write approval for clients that cannot elicit.

## Docs to update
- docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
