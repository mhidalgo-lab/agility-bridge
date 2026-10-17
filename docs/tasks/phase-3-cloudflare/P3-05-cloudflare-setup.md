---
id: P3-05
title: Cloudflare setup script
phase: 3
status: todo
priority: high
depends_on: [P3-02]
adr: []
lessons: [L-100]
owner: ""
---

# P3-05 — Cloudflare setup script

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
One idempotent command creates or updates a deployment per environment.

## Scope
- `pnpm cf:setup --name <worker>`: per-name configuration and D1 database, persisted `database_id`, dashboard variables preserved, permission and name checks.
- Secrets generated and revealed before an optional `0600` backup is written; nothing generated before the output path is proven writable.
- Committed config without ids plus an ignored local config.

## Acceptance criteria
- [ ] Re-running is a no-op; staging and production stay separate; a name mismatch is refused.

## Security notes
THREAT_MODEL T34.

## Lessons applied
- L-100 — Setup scripts are idempotent per environment.

## Docs to update
- docs/guide/cloudflare-deploy.md

## Out of scope
- Anything not listed under Scope.
