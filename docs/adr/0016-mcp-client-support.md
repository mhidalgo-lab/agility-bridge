# ADR-0016 — MCP client support policy

- **Status:** accepted (owner, 2026-10-16)
- **Date:** 2026-10-16
- **Related:** [client compatibility](../reference/client-compatibility.md), P0-07, P1-14, P4-06, P5-06, L-023 – L-029

## Context

Agility users work in many AI clients. Some take only stdio or static headers; hosted ones need OAuth; capabilities such
as elicitation (needed for write approval), MCP Apps and Tasks vary per client and version.

## Decision

- **Primary clients, documented equally:** GitHub Copilot (VS Code, JetBrains IDEs, Copilot CLI), Claude (Claude Code,
  Claude Desktop, claude.ai web, Claude mobile), Cursor, Windsurf, and MCP Inspector for debugging.
- Every primary client gets a setup guide (local stdio and remote), a connect-page snippet and a row in the
  compatibility matrix with per-feature status: `verified (version, date)`, `documented, unverified`, `not supported`.
- Secrets are never written in plain text in example configurations: use input prompts, environment variables or
  keychains as each client allows.
- A release that claims support for a client feature requires a recorded real-client check (P5-06, phase reviews).
  Unverified features are labelled as such in the docs.
- Features degrade gracefully: no Apps → text tables; no elicitation → writes refused with a clear error; no Tasks →
  inline results or explicit handles.

## Consequences

- Documentation and verification effort grows with each client; the matrix keeps it honest.
- Client-specific workarounds live behind capability checks, never behind user-agent sniffing.

## Alternatives considered

- **One primary client family:** rejected by the owner; the project targets heterogeneous teams.
