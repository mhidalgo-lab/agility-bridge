---
id: P8-46
title: "CLI workspace set merges limits instead of replacing them"
phase: 8
status: todo
priority: low
depends_on: [P8-14]
adr: []
lessons: [L-473]
owner: ""
---

# P8-46 — CLI `workspace set` merges limits instead of replacing them

> Filed by [P8-14](P8-14-quota-overrides.md) (D-336).

## Goal
`agility-bridge workspace set <id> --max-rows 20` or `--quota-daily 500` changes only that limit and keeps the others, as the panel's form does.

## Scope
- Read the workspace's current `limits`, merge the options given into them (`quota` per period), and send the whole object, so a limit set earlier is not dropped; `--quota-daily 0` style removal needs an explicit flag decided in refinement.
- The same for a grant once the CLI has a `grant update` (P7-40).

## Acceptance criteria
- [ ] A test shows `workspace set --quota-daily` keeps `maxRows` and the other limits, and the reverse.
- [ ] CLI reference regenerated.

## Security notes
THREAT_MODEL T5: a limit must not disappear because an unrelated one was changed.

## Lessons applied
- L-473 — Resolve caps as the minimum when used.

## Docs to update
- docs/reference/cli.md

## Out of scope
- Anything not listed under Scope.
