---
id: P7-34
title: CLI flags for write settings
phase: 7
status: review
priority: low
depends_on: [P7-26, P7-40]
adr: ["0013"]
lessons: [L-081]
owner: "claude"
---

# P7-34 — CLI flags for write settings

> Filed by [P7-26](P7-26-approval-policy-page-only.md). Refine scope and acceptance criteria before starting.

## Goal
An owner who works on the command line can switch writes on for a workspace, choose how writes are approved there
(`any` or `page_only`) and on a grant, like the panel and the admin API. D-208 was decided (a) on 2026-10-30 and confirmed for this task on 2026-11-03: there is **no**
deployment-wide default setting, only the CLI flags.

## Scope
- `workspace set --writes on|off --write-approval any|page_only`: the API replaces `writePolicy` as a whole, so the command
  reads the workspace first and sends the merged policy (the custom attributes of P7-20 must survive).
- `grant update --write-approval page_only|any` (landed with P7-40, #241; `any` removes the grant's switch, the workspace's own setting still applies).

## Acceptance criteria
- [x] Command tests; generated CLI reference refreshed.
- [x] A merged-policy test: changing the approval keeps `enabled` and `customFields`.

## Security notes
THREAT_MODEL T31, A13.

## Docs to update
- docs/guide/cli.md, docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
