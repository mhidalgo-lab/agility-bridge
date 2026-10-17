---
id: P8-01
title: Query cache
phase: 8
status: todo
priority: medium
depends_on: [P6-13]
adr: ["0010"]
lessons: [L-098, L-113, L-116]
owner: ""
---

# P8-01 — Query cache

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Fewer Agility requests for repeated reads, without ever mixing scopes.

## Scope
- Bounded in-memory LRU (stdio, Node, Worker isolates) and, optionally, the Workers Cache API with encrypted bodies; keys are HMACs over workspace, credential, grant, Agility projects, limits and the normalised compiled query; TTLs short (seconds) for moving windows; honest cache status (validated by read-back on Workers); never for writes.

## Acceptance criteria
- [ ] Isolation tests across workspaces and credentials; cache status reported truthfully on `workers.dev` and custom domains.

## Security notes
THREAT_MODEL T16.

## Lessons applied
- L-098 — The Cache API is local and sometimes a no-op.
- L-113 — Cache keys carry every scope dimension.
- L-116 — Quotas count logical upstream calls.

## Docs to update
- docs/guide/query-cache.md (new)

## Out of scope
- Anything not listed under Scope.
