---
id: P0-08
title: "Spike: OAuth 2.1 portability on Node and Workers"
phase: 0
status: review
priority: high
depends_on: [P0-07]
adr: ["0009"]
lessons: [L-002, L-024, L-029, L-086, L-087, L-088, L-089, L-090, L-094, L-164]
owner: "Matias Hidalgo"
---

# P0-08 — Spike: OAuth 2.1 portability on Node and Workers

## Goal
Prove that an OAuth 2.1 authorization server with one protected resource per workspace works on Node and Workers with real hosted clients.

## Scope
- Provider choice and a storage `kv` adapter usable on both runtimes.
- Per-workspace RFC 9728 metadata and RFC 8707 audience binding.
- CIMD with a connect-time SSRF guard on Node and `global_fetch_strictly_public` on Workers; capped DCR; PKCE S256; refresh rotation with a reuse window under parallel refreshes.
- A deployed test with claude.ai web (and the connector on mobile), Claude Code, VS Code, Cursor and MCP Inspector.
- A multi-isolate test proving that all state lives in storage.

## Acceptance criteria
- [x] `spikes/oauth/RESULTS.md` with real-client results, callback URLs and observed time budgets. *(Claude Code, VS Code, MCP Inspector CLI; production timings)*
- [x] Cross-workspace token rejection and a parallel-refresh test demonstrated. *(locally on workerd and Node, and in production)*
- [x] ADR-0009 accepted or superseded. *(accepted by the owner, 2026-10-21)*

## Security notes
THREAT_MODEL T9, T10, T11. Throwaway deployment, documented teardown.

## Lessons applied
- L-002 — A spike is done only when it ran in production-like conditions.
- L-024 — Hosted clients have their own rules.
- L-029 — Clients refresh OAuth tokens concurrently.
- L-086 — OAuth state lives in shared storage.
- L-087 — One protected resource per workspace.
- L-088 — Client metadata fetching is an SSRF surface.
- L-089 — Dynamic registration is a compatibility path.
- L-090 — Never revoke or replace a device on a GET an attacker can trigger.
- L-094 — Follow the OAuth details clients rely on.

## Docs to update
- docs/RESEARCH.md §4
- docs/adr/0009-authentication.md
- docs/reference/client-compatibility.md

## Out of scope
- Production OAuth (Phase 5)
