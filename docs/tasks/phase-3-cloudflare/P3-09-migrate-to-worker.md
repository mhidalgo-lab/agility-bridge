---
id: P3-09
title: Self-hosted to Worker migration
phase: 3
status: todo
priority: low
depends_on: [P3-02]
adr: ["0006"]
lessons: [L-078]
owner: ""
---

# P3-09 — Self-hosted to Worker migration

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Move a self-hosted deployment to Cloudflare without re-entering every token.

## Scope
- Export from SQLite and import into an **empty** D1 (instances, credentials ciphertext, workspaces, grants, tokens, audit, settings); sessions and OAuth devices excluded.
- Master-key handling documented (same key or re-encryption).

## Acceptance criteria
- [ ] Refuses a non-empty target; round-trip test; documented commands run against the shipped tools.

## Security notes
THREAT_MODEL T7, T29.

## Lessons applied
- L-078 — Migrations between deployments are explicit and one-way.

## Docs to update
- docs/guide/cloudflare-deploy.md (migration section)

## Out of scope
- Anything not listed under Scope.
