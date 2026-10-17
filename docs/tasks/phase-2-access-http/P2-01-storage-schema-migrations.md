---
id: P2-01
title: Storage interface, schema and migrations
phase: 2
status: todo
priority: high
depends_on: [P1-16]
adr: ["0006"]
lessons: [L-071, L-072, L-073]
owner: ""
---

# P2-01 — Storage interface, schema and migrations

## Goal
A runtime-neutral storage layer with one schema and one migration history for Node and D1.

## Scope
- `Storage` interface and repository semantics (missing → `null`; missing on update → `NotFoundError`; conflicts → `ConflictError`; rule violations → `InvalidInputError`; read-only adapter → `ReadOnlyStorageError`).
- Drizzle schema for `users`, `instances`, `credentials`, `workspaces`, `grants`, `access_tokens`, `audit_log`, `settings`, `kv`, `schema_migrations` (ARCHITECTURE §4).
- Forward-only, checksummed, embedded migrations; refuse a database newer than the binary.
- `kv` with TTL and an atomic `take` for single-use records; `setIfAbsent`; atomic counters.
- `memory` adapter and the shared contract suite; one database fixture per released minor (starting now).

## Acceptance criteria
- [ ] The contract suite passes on `memory` (SQLite and D1 adapters join in P2-02 and P3-02).
- [ ] Concurrency tests for `take`, `setIfAbsent` and counters.
- [ ] Deletion rules of ARCHITECTURE §4 enforced (cascades and restrictions).

## Security notes
THREAT_MODEL T7 (no secrets stored in plain text), T17 (append-only audit).

## Lessons applied
- L-071 — One schema, one migration history.
- L-072 — No read-decide-write in application code on D1.
- L-073 — One-time state is consumed atomically.

## Docs to update
- docs/dev/storage.md (new)
- docs/ARCHITECTURE.md §4

## Out of scope
- Anything not listed under Scope.
