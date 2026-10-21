---
id: P1-11
title: CLI with stdio mode (environment and YAML configuration)
phase: 1
status: review
priority: high
depends_on: [P1-07, P1-08]
adr: ["0006", "0014"]
lessons: [L-021, L-026, L-027, L-045, L-136]
owner: "Matias Hidalgo"
---

# P1-11 — CLI with stdio mode (environment and YAML configuration)

## Goal
`npx agility-bridge` works in every MCP client with the member's token, with clear errors when configuration is missing.

## Scope
- Default command `stdio`; environment mode (`AB_AGILITY_URL`, `AB_AGILITY_TOKEN`, `AB_*`).
- YAML mode (`AB_CONFIG`, `AB_WORKSPACE`): `${ENV}` and keychain references, unknown keys rejected, ≤ 1 MiB, warning unless `0600`.
- Lazy setup mode: with no configuration, tools are listed and calls return setup guidance; partial configuration exits 1 with a clear stderr message.
- Deprecation registry module; `--version`, `--help`; `AB_CA_FILE` for Node; no secrets accepted as flags.

## Acceptance criteria
- [x] End-to-end stdio test with the MCP client SDK against the fixture upstream.
- [x] An unknown name in `AB_TOOLS` fails startup and lists valid names.
- [x] YAML validation tests; a stdout-cleanliness test (only MCP frames on stdout).

## Security notes
THREAT_MODEL T8, T23, A9.

## Lessons applied
- L-021 — stdout belongs to the protocol in stdio mode.
- L-026 — Configure stdio servers through the client, never through flags.
- L-027 — Clients cache tool lists.
- L-045 — Deprecate on purpose.
- L-136 — One configuration surface.

## Docs to update
- docs/guide/configuration.md (new)
- docs/reference/cli.md (new, generated later)
- apps/cli/README.md (quick start)

## Out of scope
- `serve` and management commands (Phase 2)
