---
id: P5-01
title: OAuth 2.1 authorization server
phase: 5
status: todo
priority: high
depends_on: [P4-11]
adr: ["0009"]
lessons: [L-073, L-086, L-094]
owner: ""
---

# P5-01 — OAuth 2.1 authorization server

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
agility-bridge issues OAuth tokens for MCP clients, with all state in shared storage.

## Scope
- Provider integration chosen in P0-08, state in the `kv` table on both runtimes, codes consumed atomically.
- PKCE S256 for every client; form-encoded token endpoint; RFC 8414 metadata; RFC 9207 `iss`.
- Token props bound to workspace, user, grant and client; validation for the requested workspace only.

## Acceptance criteria
- [ ] Conformance tests with SDK-shaped clients on Node and workerd; replayed codes refused.
- [ ] Codes, access and refresh tokens are stored hash-only and grant properties encrypted; a scan of storage, backups, logs and audit finds no plaintext bearer value (ADR-0009).

## Security notes
THREAT_MODEL T9, T25.

## Lessons applied
- L-073 — One-time state is consumed atomically.
- L-086 — OAuth state lives in shared storage.
- L-094 — Follow the OAuth details clients rely on.

## Docs to update
- docs/dev/oauth.md (new)

## Out of scope
- Anything not listed under Scope.
