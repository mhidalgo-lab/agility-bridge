---
id: P8-05
title: Configuration import and export
phase: 8
status: done
priority: low
depends_on: [P6-13]
adr: ["0007"]
lessons: [L-065, L-078]
owner: ""
---

# P8-05 — Configuration import and export

> Refined 2026-10-30 (Phase 8 batch).

## Goal
Move or back up a deployment's configuration safely, between deployments or from a mistake.

## Scope
- `agility-bridge config export [--out <file>] [--with-tokens]` and `config import <file> [--apply] [--allow-sensitive]`,
  run by whoever holds the database and master key, or the admin token (the same two ways in as every management
  command, so owner-level only; there is no member or admin path).
- **What moves** (L-078): instances (label, address, number prefixes; not TLS file paths), shared credentials (name and
  last four characters; their tokens only with `--with-tokens`), workspaces, service grants. **What does not**: users,
  people's grants and personal credentials, device tokens, sessions, OAuth devices, audit rows.
- **Tokens**: excluded by default. `--with-tokens` (local only, needs `--out`) seals them with a passphrase
  (PBKDF2-HMAC-SHA-256, 600,000 iterations, AES-256-GCM, fresh salt and IV, header authenticated); the passphrase comes
  from `AB_CONFIG_PASSPHRASE`, `--passphrase-file`, standard input or a prompt, never a flag, 12 characters at least. A
  wrong passphrase and a changed file give one message. Exporting tokens is an audit event (counts, no value).
- **Import is additive and a dry run unless `--apply`**: it creates what is missing and never updates or deletes what
  exists (matched by instance address, shared credential label and workspace slug; grants only go to workspaces the same import creates), through the admin
  API, so validation, guards and audit rows are the same as for any command. Credentials are created only as shared
  ones from the file's sealed tokens; grants only for services; a personal credential is never used, replaced or
  referenced; workspaces that enable writes or pass-through need `--allow-sensitive`.
- The file is strict (unknown fields, owners, users and clear tokens are errors), at most 1 MiB with bounded counts,
  and its references must resolve inside it.

## Acceptance criteria
- [x] Escalation tests: an import cannot widen an existing workspace, create a grant for a person, reference or reuse a
      personal credential, name an owner or carry a clear token; sensitive workspaces are skipped without the flag.
- [x] No secret in the file without a passphrase; the sealed file holds no token or passphrase in clear (tests).
- [x] Dry run writes nothing (target database unchanged); a second `--apply` changes nothing.
- [x] The passphrase seal: round trip, wrong passphrase, tampered header and ciphertext, other KDF or cost refused.
- [x] Negative authorization: through a server, a wrong admin token imports nothing.
- [x] `docs/guide/migrating-config.md` written; `docs/reference/cli.md` regenerated.

## Security notes
THREAT_MODEL T29.

## Lessons applied
- L-065 — Every alternate writer is an authorization boundary.
- L-078 — Migrations between deployments are explicit and one-way.

## Docs to update
- docs/guide/migrating-config.md (new)

## Out of scope
- Users, people's grants and device tokens (identity belongs to the target's sign-in); moving between deployments of
  different master keys other than through the passphrase seal; a server-side import endpoint; updating existing records.
