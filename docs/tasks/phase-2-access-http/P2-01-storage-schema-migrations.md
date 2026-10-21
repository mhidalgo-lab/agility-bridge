---
id: P2-01
title: Storage interface, schema and migrations
phase: 2
status: review
priority: high
depends_on: [P1-16]
adr: ["0006"]
lessons: [L-071, L-072, L-073]
owner: "Matias Hidalgo"
---

# P2-01 — Storage interface, schema and migrations

## Goal
A runtime-neutral storage layer with one schema and one migration history for Node and D1.

## Scope
- `Storage` interface and repository semantics (missing → `null`; missing on update → `NotFoundError`; conflicts → `ConflictError`; rule violations → `InvalidInputError`; read-only adapter → `ReadOnlyStorageError`).
- Drizzle schema for `users`, `instances`, `credentials`, `workspaces`, `grants`, `access_tokens`, `audit_log`, `settings`, `kv`, `schema_migrations` (ARCHITECTURE §4).
- Forward-only, checksummed, embedded migrations; refuse a database newer than the binary.
- `kv` with TTL and an atomic `take` for single-use records; `setIfAbsent`; atomic counters.
- Conditional writes decide on `RETURNING` rows, never on driver change counts (D1 counts cascaded rows, `node:sqlite` does not, L-161); `PRAGMA foreign_keys = ON` per `node:sqlite` connection; STRICT tables (P0-09).
- `memory` adapter and the shared contract suite; one database fixture per released minor (starting now).

## Acceptance criteria
- [x] The contract suite passes on `memory` (SQLite and D1 adapters join in P2-02 and P3-02). *(It also passes on
  the shared SQL implementation over `node:sqlite` `:memory:`, through the driver in `packages/storage-sqlite`; P2-02
  adds file handling.)*
- [x] Concurrency tests for `take`, `setIfAbsent` and counters. *(Plus `touch` and duplicate creates; on SQLite also
  across two connections to one file.)*
- [x] Deletion rules of ARCHITECTURE §4 enforced (cascades and restrictions).

## Notes
- The SQL implementation (`createSqlStorage` over a `SqlDriver`) lives here so that node:sqlite and D1 share every
  statement; adapters only provide the driver.
- Migrations are hand-written TypeScript modules (`src/migrations/`), one statement per entry, because Drizzle's
  generator cannot express STRICT tables, CHECK constraints or triggers; a test compares the DDL with `schema.ts`.
- Cross-row rules from ADR-0008 and THREAT_MODEL A14/T17 are triggers, so they hold for every writer.
- Deleting a user that owns credentials or has grants is refused (ARCHITECTURE §4 did not say; disabling is the path).

## Security notes
THREAT_MODEL T7 (no secrets stored in plain text), T17 (append-only audit).

## Lessons applied
- L-071 — One schema, one migration history.
- L-072 — No read-decide-write in application code on D1.
- L-073 — One-time state is consumed atomically.

## Docs to update
- [x] docs/dev/storage.md (new)
- [x] docs/ARCHITECTURE.md §4

## Out of scope
- Anything not listed under Scope.
