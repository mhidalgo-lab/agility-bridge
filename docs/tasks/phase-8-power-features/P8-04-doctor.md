---
id: P8-04
title: doctor command
phase: 8
status: todo
priority: medium
depends_on: [P6-13]
adr: []
lessons: [L-077, L-026]
owner: ""
---

# P8-04 — doctor command

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Diagnose a setup without changing it.

## Scope
- Read-only checks: configuration, Node version, instance reachability and TLS, token validity (with consent), database and key consistency, client configuration files for every primary client; `--fix` for explicit repairs only.

## Acceptance criteria
- [ ] A test proves `doctor` without `--fix` never writes; scrubbed output.

## Security notes
THREAT_MODEL T28.

## Lessons applied
- L-077 — Diagnostics are read-only.
- L-026 — Configure stdio servers through the client, never through flags.

## Docs to update
- docs/reference/cli.md
- docs/guide/troubleshooting.md

## Out of scope
- Anything not listed under Scope.
