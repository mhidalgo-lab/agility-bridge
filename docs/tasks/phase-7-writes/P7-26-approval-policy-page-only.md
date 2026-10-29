---
id: P7-26
title: "Approval policy: page only, per workspace or grant"
phase: 7
status: done
priority: medium
depends_on: [P7-02]
adr: ["0013"]
lessons: [L-106]
owner: ""
---

# P7-26 — Approval policy: page only, per workspace or grant

> Filed by the Phase 7 review ([P7-09](P7-09-phase-7-review.md)). Refined 2026-10-29 (lane A).

## Goal
A client that auto-accepts elicitation proves no human answered (review M3). Let an owner require the out-of-band page for writes, per workspace or grant; the owner decides the default (D-11 allowed elicitation).

## Scope
- **Workspace.** `writePolicy.approval`: `any` (today, the default) or `page_only`. Set by an owner with a recent sign-in
  (the same guard as every write setting), through the admin API (`PATCH /workspaces/{id}`, `writePolicy`) and the
  workspace form (a select, owners only).
- **Grant.** `rateLimit.writeApproval: "page_only"` (the grant's existing JSON column, like `writesPerHour`, P7-15). It can
  only tighten: the effective policy is `page_only` when the workspace or the grant says so. An owner with a recent sign-in
  sets or removes it (API, grant form select, owners only).
- **Pipeline.** `EffectiveAccess.writeApproval` becomes `WriteRuntime.approvalPolicy`. Under `page_only` the request's
  channel is the approval page whatever the client declared: no `elicitation/create`, no `input_required`, and a client that
  auto-accepts cannot approve (a sealed state with an "approve" answer is ignored, there is no round). Without a page
  (sign-in off, a service grant) the answer is `AB_WRITE_APPROVAL_UNAVAILABLE` with its own hint. `whoami` and dry runs report
  `page`.
- Documents the residual risk: a browser-driving agent that holds the person's session can still approve on the page; the
  recent sign-in and the short window are the barrier.
- Out of scope, filed as follow-ups: CLI flags for write settings (the CLI has none for writes today, P7-40 covers grants),
  a deployment-wide default switch (the owner decides the default, D-208), stdio (single user, approval off by D-10).

## Acceptance criteria
- [x] A `page_only` workspace or grant never sends an elicitation (tests on the real MCP server, both protocol eras), and a
      client that can elicit still gets the link.
- [x] A client that auto-accepts cannot approve under `page_only` (test: a forged round answer and a push accept).
- [x] Only an owner with a recent sign-in sets or removes the setting; an administrator and a member cannot (tests).
- [x] The default for OAuth clients that are not allowlisted is recorded as an open owner decision (D-208), built as `any`.

## Security notes
THREAT_MODEL T31, A2, A13.

## Lessons applied
- L-106 — Show the whole change, never a summary.

## Docs to update
- docs/guide/write-tools.md
- docs/THREAT_MODEL.md

## Out of scope
- Anything not listed under Scope.
