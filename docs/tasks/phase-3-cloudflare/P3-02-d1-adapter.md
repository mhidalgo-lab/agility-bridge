---
id: P3-02
title: D1 adapter and shared migration runner
phase: 3
status: done
priority: high
depends_on: [P3-01]
adr: ["0006"]
lessons: [L-071, L-072, L-073]
owner: ""
---

# P3-02 — D1 adapter and shared migration runner

> Refined 2026-10-22 (tasks/README rule 7).

## Goal
D1 passes the same storage contract as SQLite and memory, with the same migrations, and resolving access costs one
D1 round trip.

## Scope
- The D1 `SqlDriver` (P3-01) moves to `packages/storage` (`createD1Driver`, web-standard, no dependency), next to the
  driver contract; the Worker imports it from there.
- The full storage contract suite (`packages/storage/test/contract.ts`) runs on local D1 (Miniflare, from Node through
  `getD1Database`), with a fresh database per test. Every difference it finds is fixed in the driver or the shared SQL,
  never by weakening the contract: error classification of D1's messages (`ab_invalid`, `ab_conflict`, unique, foreign
  key, check), conditional writes decided on `RETURNING` rows (L-161), atomic `batch()`.
- Migrations on D1: concurrent first boots of the same database (several isolates migrating at once) end with one
  history and no error; a database written by a newer version is refused, as on SQLite.
- **Access in one round trip**: a storage method that loads the token, grant, workspace, user, instance and credential
  for a token hash in one call — one `batch()` of single-table SELECTs keyed by subqueries on SQL, a lookup in memory —
  used by `authenticateDeviceToken`; the result is identical to the current sequential loads (property-checked on the
  contract suite's worlds).

## Acceptance criteria
- [x] `storageContract('d1 (local)', …)` passes in full; concurrent first boots tested (several storages migrating one
      database at once).
- [x] The access bundle returns the same records as the sequential loads on memory, SQLite and D1, including revoked,
      expired, disabled and missing rows; on SQL it is one driver call.
- [x] `docs/dev/storage.md` describes the D1 driver, its batch semantics and the access bundle.

## Security notes
THREAT_MODEL T7.

## Lessons applied
- L-071 — One schema, one migration history.
- L-072 — No read-decide-write in application code on D1.
- L-073 — One-time state is consumed atomically.

## Docs to update
- docs/dev/storage.md

## Notes
- The contract suite passed on D1 as soon as it ran: the shared SQL already decided every conditional write on
  `RETURNING` rows, so no driver or SQL change was needed. The only fix was test-side (dropping tables child-first
  between tests).

## Out of scope
- Remote D1 (P3-05 creates databases; P3-11 runs against one); Durable Objects; read replicas.
