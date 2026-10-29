---
id: P7-40
title: CLI command to change a grant
phase: 7
status: todo
priority: low
depends_on: [P7-15]
adr: ["0013"]
lessons: [L-081]
owner: ""
---

# P7-40 — CLI command to change a grant

> Filed by [P7-15](P7-15-per-grant-write-limit.md). Refine scope and acceptance criteria before starting.

## Goal
An owner who works on the command line can set a grant's per-minute rate and its hourly write limit (`rateLimit`), like the panel and the admin API.

## Scope
- `grant update <grant-id>` over `PATCH /grants/{id}` with `--rate-per-minute` and `--writes-per-hour` (and, if cheap, the other grant fields the API accepts).
- The same owner-only and recent-sign-in rules as the API (the CLI client acts as the break-glass actor, which the guards already treat as an owner).

## Acceptance criteria
- [ ] Command tests, generated CLI reference refreshed.

## Security notes
THREAT_MODEL T31.

## Docs to update
- docs/guide/cli.md, docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
