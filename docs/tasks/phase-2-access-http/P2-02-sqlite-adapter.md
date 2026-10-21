---
id: P2-02
title: SQLite adapter for Node
phase: 2
status: review
priority: high
depends_on: [P2-01]
adr: ["0006"]
lessons: [L-076, L-102, L-104]
owner: "Matias Hidalgo"
---

# P2-02 — SQLite adapter for Node

## Goal
Durable, safe storage for `agility-bridge serve` on `node:sqlite`.

## Scope
- Adapter on `node:sqlite`: WAL, `busy_timeout`, foreign keys on, migrate on open.
- Files created with `O_EXCL | O_NOFOLLOW`, mode `0600` (directories `0700`), permissions tightened through the opened handle.
- Consistent `0600` backups.

## Acceptance criteria
- [x] Contract suite passes on SQLite on Linux, macOS and Windows. *(`:memory:` and a real WAL file; the
  `SQLite and CLI` CI jobs run it on macOS and Windows.)*
- [x] Symlink and permission tests; backup and restore test. *(POSIX-only where modes and links apply; mutation-checked:
  dropping `O_NOFOLLOW` or the `fchmod` fails them.)*

## Security notes
THREAT_MODEL T7, T35.

## Lessons applied
- L-076 — Handle files defensively.
- L-102 — Keep the Node footprint portable.
- L-104 — Test SQLite on Windows too.

## Docs to update
- [x] docs/dev/storage.md

## Out of scope
- Anything not listed under Scope.
