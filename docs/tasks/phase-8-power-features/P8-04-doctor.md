---
id: P8-04
title: doctor command
phase: 8
status: todo
priority: medium
depends_on: [P6-13]
adr: []
lessons: [L-077, L-026]
owner: ""
---

# P8-04 — doctor command

> Refined 2026-10-30 (Phase 8 batch).

## Goal
Diagnose a setup without changing it: one command that says what is wrong with the configuration, the instance, the keys
and the client files, and how to fix it.

## Scope
`agility-bridge doctor [--check-token] [--offline] [--fix] [--json]`. Every check prints `ok`, `warn`, `fail`, `skip` or
`info` with a one-line cause and a hint; the exit code is 1 when any check fails. Checks, all read-only:
- **Runtime**: Node version against `engines`.
- **Configuration** of this shell (`loadConfig`: env or `AB_CONFIG`). No configuration here is not a failure: a client
  sets its own `env` block (L-026); the output says so.
- **Instance**, when configured and not `--offline`: one unauthenticated `GET meta.v1/Member` with no redirects, HTTPS
  only, to the configured address only (the existing instance probe: reachability, TLS, "is it Agility"). Honours
  `AB_CA_FILE` and `AB_INSTANCE_PRIVATE_ADDRESSES`.
- **Token**, only with `--check-token` (explicit consent, one authenticated request; the output names neither the member
  nor the token, only valid / refused / unavailable and how many projects it reaches).
- **Server data**, when a local database or master key is configured: file and directory modes, the master key (a file
  readable by others, inside the data directory, wrong shape), the database opened read-only (never created, never
  migrated; `immutable` when no WAL file exists so that no side file is written), pending or newer migrations, the
  recorded key-check values against the loaded keys, credentials sealed under a key that is not loaded.
- **Client files** of every primary client (Claude Code, VS Code and Copilot, Copilot CLI, JetBrains, Claude Desktop,
  Cursor, Windsurf): the agility-bridge entry's secrets in `args`, a plain-text token, a non-HTTPS address, unknown
  `AB_` names, and the file's mode. Values are never printed, only key names and paths.
- **`--fix`** applies only the repairs listed in its own output, all of them `chmod`: key, admin-token and config files
  to 0600, the data directory to 0700, a client file that holds a plain-text token to 0600. Nothing else: no migration,
  no key creation, no content edits, no symbolic links followed.

## Acceptance criteria
- [ ] A test proves `doctor` without `--fix` never writes (directory snapshot of names, modes and contents before and
      after, also with a database present) and that `--fix` changes only the listed modes.
- [ ] Output is scrubbed: tokens, master keys and admin tokens never appear in text or JSON (tests with planted
      secrets in the environment, the config file, the client files and the database).
- [ ] The token check runs only with `--check-token`; without it no authenticated request is made (fake fetch).
- [ ] Negative tests: an `http://` instance, a redirecting instance and a private address under `refuse` get no probe
      or no follow; a symbolic link is neither read as a client file nor changed by `--fix`.
- [ ] `docs/reference/cli.md` regenerated; the troubleshooting page points to `doctor`.

## Security notes
THREAT_MODEL T28.

## Lessons applied
- L-077 — Diagnostics are read-only.
- L-026 — Configure stdio servers through the client, never through flags.

## Docs to update
- docs/reference/cli.md
- docs/guide/troubleshooting.md

## Out of scope
- Repairing content (editing client files, running migrations, creating keys) and any check of a remote
  deployment (the admin API's own health views cover it).
- A real-client run of the file locations on macOS and Windows: paths are tested with fakes; marked *unverified*.
