---
id: P7-34
title: CLI flags for write settings and a default approval policy
phase: 7
status: todo
priority: low
depends_on: [P7-26, P7-40]
adr: ["0013"]
lessons: [L-081]
owner: ""
---

# P7-34 — CLI flags for write settings and a default approval policy

> Filed by [P7-26](P7-26-approval-policy-page-only.md). Refine scope and acceptance criteria before starting.

## Goal
An owner who works on the command line can switch writes on for a workspace, choose how writes are approved there
(`any` or `page_only`) and on a grant, and, if the owner decides so in D-208, set a deployment-wide default, like the panel
and the admin API.

## Scope
- `workspace set --writes on|off --write-approval any|page_only`: the API replaces `writePolicy` as a whole, so the command
  reads the workspace first and sends the merged policy (the custom attributes of P7-20 must survive).
- `grant update --write-approval page_only|workspace` once P7-40 lands (the same owner and recent-sign-in rules as the API).
- If the owner asks for it (D-208 option d): a server setting for the default policy of workspaces and grants that say
  nothing, shown by `whoami` and the configuration reference.

## Acceptance criteria
- [ ] Command tests; generated CLI reference refreshed.
- [ ] A merged-policy test: changing the approval keeps `enabled` and `customFields`.

## Security notes
THREAT_MODEL T31, A13.

## Docs to update
- docs/guide/cli.md, docs/guide/write-tools.md, docs/guide/configuration.md (only with the default switch)

## Out of scope
- Anything not listed under Scope.
