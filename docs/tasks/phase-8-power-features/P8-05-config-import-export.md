---
id: P8-05
title: Configuration import and export
phase: 8
status: todo
priority: low
depends_on: [P6-13]
adr: ["0007"]
lessons: [L-065, L-078]
owner: ""
---

# P8-05 — Configuration import and export

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Move or back up configuration safely.

## Scope
- Owner-only; tokens excluded by default or encrypted with a passphrase (PBKDF2-HMAC-SHA-256, 600,000 iterations, AES-256-GCM); additive import with dry run; never assigns another user's personal credential.

## Acceptance criteria
- [ ] Escalation tests (import cannot widen access or reuse personal credentials).

## Security notes
THREAT_MODEL T29.

## Lessons applied
- L-065 — Every alternate writer is an authorization boundary.
- L-078 — Migrations between deployments are explicit and one-way.

## Docs to update
- docs/guide/migrating-config.md (new)

## Out of scope
- Anything not listed under Scope.
