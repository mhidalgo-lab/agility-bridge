---
id: P3-08
title: Scheduled jobs: audit purge and key rotation on D1
phase: 3
status: todo
priority: medium
depends_on: [P3-02]
adr: ["0007"]
lessons: [L-075]
owner: ""
---

# P3-08 — Scheduled jobs: audit purge and key rotation on D1

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Housekeeping works on Workers without a long-running process.

## Scope
- Cron triggers for audit and `kv` purge; resumable master-key rotation in bounded batches; guards against concurrent rotations.

## Acceptance criteria
- [ ] Interrupted rotation resumes; purge respects retention.

## Security notes
THREAT_MODEL T7.

## Lessons applied
- L-075 — Envelope encryption done properly.

## Docs to update
- docs/guide/secrets.md

## Out of scope
- Anything not listed under Scope.
