---
id: P2-10
title: CLI management commands (local and remote)
phase: 2
status: todo
priority: medium
depends_on: [P2-09]
adr: ["0008"]
lessons: [L-026, L-065]
owner: ""
---

# P2-10 — CLI management commands (local and remote)

## Goal
Operators manage a deployment from the terminal with the same validation and audit as the API.

## Scope
- `init` (writes a new master key to the user configuration directory, P2-03), `admin-token` (done in P2-09),
  `user|instance|credential|workspace|grant|token` commands, `audit tail`.
- `keys status|rotate|retire` (local only: they need the database and the master keys), as documented in
  docs/guide/secrets.md (P2-03).
- Local mode by default (the database of `AB_DB_PATH`/`AB_DATA_DIR`, acting as break-glass owner); remote mode when
  `AB_ADMIN_URL` is set (the admin API with `AB_ADMIN_TOKEN(_FILE)`). Output is JSON on stdout; messages on stderr.
- Remote client (HTTPS only, no redirects) and an in-process local client over SQLite sharing the admin API.
- Secrets only from a hidden prompt, stdin, a file or an environment variable — never flags.

## Acceptance criteria
- [ ] Local and remote modes produce identical results and audit rows (local rows carry `via: cli`).
- [ ] No secret appears in argv in any documented command (test).

## Security notes
THREAT_MODEL T8, T23.

## Lessons applied
- L-026 — Configure stdio servers through the client, never through flags.
- L-065 — Every alternate writer is an authorization boundary.

## Docs to update
- docs/guide/cli.md (new)
- docs/reference/cli.md (generated)

## Out of scope
- Anything not listed under Scope.
