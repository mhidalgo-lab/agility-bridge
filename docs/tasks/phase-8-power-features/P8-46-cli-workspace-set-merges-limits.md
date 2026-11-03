---
id: P8-46
title: "CLI workspace set merges limits instead of replacing them"
phase: 8
status: review
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
- Read the workspace's current `limits`, merge the options given into them (`quota` per period), and send the whole object, so a limit set earlier (including the switches and budgets set in the panel) is not dropped.
- Removal (refined): `--max-rows none`, `--quota-daily none`, `--quota-monthly none`, as `grant update` already does for its rate options (P7-40); removing the last period removes `quota`. The API's owner rules decide whether a removal or raise is allowed.
- The same for a grant: `grant update --quota-daily|--quota-monthly` (P7-40 exists).

## Acceptance criteria
- [x] A test shows `workspace set --quota-daily` keeps `maxRows` and the other limits, and the reverse (`apps/cli/test/merge-limits.test.ts`, also `none` and `grant update`).
- [x] CLI reference regenerated.

## Security notes
THREAT_MODEL T5: a limit must not disappear because an unrelated one was changed.

## Lessons applied
- L-473 — Resolve caps as the minimum when used.

## Docs to update
- docs/reference/cli.md

## Out of scope
- Anything not listed under Scope.
