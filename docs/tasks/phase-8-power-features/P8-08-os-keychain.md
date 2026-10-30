---
id: P8-08
title: OS keychain support
phase: 8
status: review
priority: low
depends_on: [P6-13]
adr: ["0007"]
lessons: [L-103]
owner: ""
---

# P8-08 — OS keychain support

> Refined 2026-10-30 (Phase 8 batch).

## Goal
Keep Agility tokens and the master key out of configuration files on developer machines and single-host servers.

## Scope
- **References**: `keychain:<name>` (service `agility-bridge`) or `keychain:<service>/<account>` as the whole value of
  `AB_AGILITY_TOKEN` (stdio), `AB_MASTER_KEY` and `AB_MASTER_KEY_PREVIOUS` (`serve`, management commands), and inside
  `${keychain:…}` in the YAML file (the existing form, now also with a bare name). Resolved when the process starts; the
  secret is held in a `Secret` and never logged.
- **Backends, no native module** (L-103): macOS `security` (`find-generic-password`, `delete-generic-password`, and
  `security -i` with the secret as hex on standard input to add); Linux `secret-tool` (`lookup`, `store` with the secret
  on standard input, `clear`); Windows PowerShell calling `CredRead`/`CredWrite`/`CredDelete` of the Credential Manager,
  the script in `-EncodedCommand` and the secret on standard input. No shell, no secret in argv or in a command line.
- **No silent fallback**: a missing tool, a locked or unreachable store, a timeout and a missing entry are errors that
  name the cause and the command to fix it; an unsupported platform says what to use instead.
- **Commands** (no server needed): `agility-bridge keychain set <name>` (the secret from `--from-file`, standard input,
  `AB_KEYCHAIN_SECRET` or a hidden prompt; the entry is read back to prove it was stored), `keychain delete <name>`,
  `keychain status [<name>]` (which backend, whether it can start, whether an entry exists; never prints a value), and
  `init --keychain <name>` (a new master key straight into the keychain, never in a file).
- `doctor` accepts a reference as a non-plain-text token.
- Testability: the platform code runs against fake tools on every OS (macOS and Windows CI jobs included); tests against
  the real keychain are opt-in (`AB_TEST_KEYCHAIN=1`) and never run in CI.

## Acceptance criteria
- [x] No secret in argv or in the child's environment, on all three platforms (tests with fake runners record every call).
- [x] No silent fallback: missing tool, failed tool, unsupported platform, missing entry and failed read-back each error (tests).
- [x] References resolve for the stdio token, the master keys and the YAML form; a malformed or missing one stops startup naming it, never a value.
- [x] `keychain set/delete/status` and `init --keychain` tested; `docs/reference/cli.md` regenerated.
- [ ] Manual verification on macOS, Linux and Windows recorded (owner step: the maintainers' machines; the Windows script is *unverified* until then).

## Security notes
THREAT_MODEL T8.

## Lessons applied
- L-103 — No native keychain modules.

## Docs to update
- docs/guide/secrets.md

## Out of scope
- Cloudflare Workers (secrets come from Worker secrets); a keychain for the admin token; reading the keychain from the admin panel.
