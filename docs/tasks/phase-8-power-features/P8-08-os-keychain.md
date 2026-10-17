---
id: P8-08
title: OS keychain support
phase: 8
status: todo
priority: low
depends_on: [P6-13]
adr: ["0007"]
lessons: [L-103]
owner: ""
---

# P8-08 — OS keychain support

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Keep Agility tokens and the master key out of configuration files on developer machines.

## Scope
- `keychain:<name>` references for stdio and `serve`; macOS `security -i`, Linux `secret-tool`, Windows Credential Manager; secrets via stdin; no silent fallback.

## Acceptance criteria
- [ ] Manual verification on the three OSes recorded; no secret in argv (test).

## Security notes
THREAT_MODEL T8.

## Lessons applied
- L-103 — No native keychain modules.

## Docs to update
- docs/guide/secrets.md

## Out of scope
- Anything not listed under Scope.
